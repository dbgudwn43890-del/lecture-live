import assert from "node:assert/strict";
import test from "node:test";
import { AudioVerificationError, encodedFlacDuration, verifyAudio, verifyAudioStream } from "./verified-audio.ts";

export function wav(seconds: number, sampleRate = 8000): Uint8Array {
  const data = Buffer.alloc(44 + seconds * sampleRate * 2);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}

test("fully decodes a 180-second WAV and returns canonical duration and audio", async () => {
  const result = await verifyAudio(new File([new Uint8Array(wav(180))], "lecture.wav", { type: "audio/wav" }));
  assert.equal(result.durationMs, 180_000);
  assert.equal(encodedFlacDuration(result.bytes), 180_000);
  assert.equal(Buffer.from(result.bytes).toString("ascii", 0, 4), "fLaC");
});

test("rejects a fake recording before it can reach paid transcription", async () => {
  await assert.rejects(() => verifyAudio(new File(["not audio"], "lecture.mp3")));
});

test("does not accept a playlist that references an external source", async () => {
  await assert.rejects(() => verifyAudio(new File(["#EXTM3U\nhttps://example.invalid/audio.mp3"], "lecture.mp3")));
});

test("rejects client-provided metadata masquerading as measured FLAC", () => {
  assert.throws(() => encodedFlacDuration(Buffer.from("not a real encoder result")));
});

test("a stored WAV larger than the web request limit streams to the real decoder", async () => {
  const file = new File([new Uint8Array(wav(180, 16_000))], "three-minutes.wav");
  assert.ok(file.size > 4_500_000);
  const result = await verifyAudioStream(file.stream(), file.size);
  assert.equal(result.durationMs, 180_000);
  assert.equal(encodedFlacDuration(result.bytes), 180_000);
});

test("the storage stream cannot exceed its authorized byte count", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.close(); } });
  await assert.rejects(() => verifyAudioStream(stream, 9), (error: unknown) => error instanceof AudioVerificationError && error.code === "too_large");
});

test("truncated storage objects are rejected and release temporary resources", async () => {
  const file = new File([new Uint8Array(wav(1))], "lecture.wav");
  await assert.rejects(() => verifyAudioStream(file.stream(), file.size + 1), (error: unknown) => error instanceof AudioVerificationError && error.code === "invalid");
  assert.equal((await verifyAudio(file)).durationMs, 1_000);
});

test("interrupted storage downloads remain retryable", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("connection ended")); } });
  await assert.rejects(() => verifyAudioStream(stream, 10), (error: unknown) => error instanceof AudioVerificationError && error.code === "unavailable");
});

test("concurrent decodes do not overfill shared temporary disk", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const bytes = new Uint8Array(wav(1));
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const first = verifyAudioStream(stream, bytes.byteLength);
  const second = new File([bytes], "second.wav");
  await assert.rejects(() => verifyAudio(second), (error: unknown) => error instanceof AudioVerificationError && error.code === "busy");
  controller.enqueue(bytes); controller.close();
  assert.equal((await first).durationMs, 1_000);
});
