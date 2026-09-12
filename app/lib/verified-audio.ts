import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_AUDIO_MS } from "./lecture-audio.ts";
import { MAX_AUDIO_UPLOAD_BYTES, MAX_VERIFIED_AUDIO_BYTES } from "./lecture-audio-transfer.ts";

let decoding = false;

export class AudioVerificationError extends Error {
  code: "invalid" | "too_long" | "too_large" | "unavailable" | "busy";
  constructor(code: "invalid" | "too_long" | "too_large" | "unavailable" | "busy") { super(code); this.code = code; }
}

/** Read duration from our encoder's output, never from an uploaded header. */
export function encodedFlacDuration(bytes: Uint8Array): number {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.length < 42 || header.toString("ascii", 0, 4) !== "fLaC" || (header[4] & 0x7f) !== 0 || header.readUIntBE(5, 3) !== 34) {
    throw new AudioVerificationError("invalid");
  }
  const packed = header.readBigUInt64BE(18);
  const rate = Number(packed >> 44n);
  const samples = Number(packed & 0xfffffffffn);
  if (!rate || !samples) throw new AudioVerificationError("invalid");
  return Math.ceil(samples * 1_000 / rate);
}

/**
 * Fully decode the audio stream and re-encode losslessly. Header-only duration
 * probes can be forged. Canonical FLAC also makes the provider process exactly
 * the stream that was measured, without video, playlists, or secondary tracks.
 * Keep sample rate/channels; this is not an audio-quality reduction.
 */
export async function verifyAudio(file: File): Promise<{ bytes: Uint8Array; durationMs: number }> {
  return verifyAudioStream(file.stream(), file.size);
}

/** Download only a server-owned object, bounding bytes as they reach disk. */
export async function verifyAudioStream(stream: ReadableStream<Uint8Array>, expectedBytes: number): Promise<{ bytes: Uint8Array; durationMs: number }> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_AUDIO_UPLOAD_BYTES) {
    await stream.cancel();
    throw new AudioVerificationError("too_large");
  }
  // Fluid compute can share a process and its temporary disk across requests.
  // One input/output pair uses at most 456 MiB; a second must retry elsewhere.
  if (decoding) { await stream.cancel(); throw new AudioVerificationError("busy"); }
  decoding = true;
  const executable = join(process.cwd(), ".ffmpeg", "ffmpeg");
  let directory: string | undefined;
  let inputReady = false;
  try {
    directory = await mkdtemp(join(tmpdir(), "lecue-audio-"));
    const input = join(directory, "input");
    const output = join(directory, "verified.flac");
    let received = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength;
        callback(received > expectedBytes || received > MAX_AUDIO_UPLOAD_BYTES ? new AudioVerificationError("too_large") : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]), bounded, createWriteStream(input), { signal: AbortSignal.timeout(60_000) });
    if (received !== expectedBytes) throw new AudioVerificationError("invalid");
    inputReady = true;
    await new Promise<void>((resolve, reject) => {
      // No shell, network protocols, video decoding, or inherited API keys.
      const child = spawn(executable, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
        "-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1",
        "-protocol_whitelist", "file", "-format_whitelist", "mp3,wav,mov,matroska,webm",
        "-i", input, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
        "-af", "asetpts=N/SR/TB", "-t", String(MAX_AUDIO_MS / 1_000 + 1),
        "-c:a", "flac", "-compression_level", "0", "-threads", "1",
        "-fs", String(MAX_VERIFIED_AUDIO_BYTES), "-y", output,
      ], { stdio: "ignore", env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, TMPDIR: directory } });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.once("error", () => { clearTimeout(timeout); reject(new AudioVerificationError("unavailable")); });
      child.once("exit", code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new AudioVerificationError("invalid")); });
    });
    const result = await stat(output);
    // FFmpeg -fs can stop between frames. Never accept a size-limited partial.
    if (result.size >= MAX_VERIFIED_AUDIO_BYTES - 1_048_576) throw new AudioVerificationError("too_large");
    const bytes = await readFile(output);
    const durationMs = encodedFlacDuration(bytes);
    if (durationMs > MAX_AUDIO_MS) throw new AudioVerificationError("too_long");
    return { bytes, durationMs };
  } catch (error) {
    if (error instanceof AudioVerificationError) throw error;
    throw new AudioVerificationError(inputReady ? "invalid" : "unavailable");
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { decoding = false; }
  }
}
