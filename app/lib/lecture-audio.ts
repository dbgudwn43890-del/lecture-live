import { createHmac, timingSafeEqual } from "node:crypto";

import type { DeepgramLanguage } from "./deepgram.ts";
import { keytermBudget } from "./deepgram.ts";

/**
 * UPL-02. The product cap is three hours, not the five in PRD 9.4: every other
 * ceiling in the codebase — `transcript_segments.start_ms`, the `duration_seconds`
 * check, and the 0..179 minute index `consume_lecture_credits` accepts — stops at
 * three, and a five-hour file would bill and store only its first three hours
 * while reporting success. Raise all four together or none.
 */
export const MAX_AUDIO_MS = 10_800_000;
export const MAX_AUDIO_BYTES = 1_073_741_824;

/** Deepgram utterances are per-sentence; the columns they land in cap at these. */
const MAX_TEXT = 2_000;
const MAX_ID_TEXT = 120;

export type PrerecordedWord = { start?: unknown; end?: unknown; word?: unknown; punctuated_word?: unknown };
export type PrerecordedUtterance = { start?: unknown; end?: unknown; transcript?: unknown; words?: PrerecordedWord[] };
export type PrerecordedResult = {
  metadata?: { duration?: unknown; request_id?: unknown };
  results?: {
    utterances?: PrerecordedUtterance[];
    channels?: Array<{ alternatives?: Array<{ transcript?: unknown; words?: PrerecordedWord[] }> }>;
  };
};

export type AudioSegment = { id: string; startMs: number; endMs: number; text: string };

function seconds(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Turns one prerecorded response into the same `{ id, startMs, endMs, text }`
 * rows a live lecture saves, so an uploaded lecture is indistinguishable from a
 * recorded one downstream — same table, same chunking, same citations (UPL-07).
 *
 * `utterances=true` gives sentence-level boundaries, which is the closest match
 * to what the live path produces from speech_final. A response without them
 * (the flag was dropped, or the audio held one long alternative) falls back to
 * slicing the word list on the same 45-second/600-character rule the live
 * buffer uses, rather than storing one unusable 3-hour paragraph.
 */
export function segmentsFromPrerecorded(payload: PrerecordedResult): AudioSegment[] {
  const utterances = payload.results?.utterances ?? [];
  const rows: AudioSegment[] = [];

  if (utterances.length) {
    for (const utterance of utterances) {
      const text = typeof utterance.transcript === "string" ? utterance.transcript.trim() : "";
      const start = seconds(utterance.start);
      const end = seconds(utterance.end);
      if (!text || start === null || end === null) continue;
      rows.push(buildSegment(start, Math.max(start, end), text));
    }
    return dedupe(rows);
  }

  const words = payload.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  let bucket: PrerecordedWord[] = [];
  const flush = () => {
    if (!bucket.length) return;
    const start = seconds(bucket[0].start) ?? 0;
    const end = seconds(bucket.at(-1)?.end) ?? start;
    const text = bucket
      .map((word) => (typeof word.punctuated_word === "string" ? word.punctuated_word : String(word.word ?? "")))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) rows.push(buildSegment(start, Math.max(start, end), text));
    bucket = [];
  };

  for (const word of words) {
    bucket.push(word);
    const start = seconds(bucket[0].start) ?? 0;
    const end = seconds(word.end) ?? start;
    const spoken = bucket.reduce((total, item) => total + String(item.punctuated_word ?? item.word ?? "").length + 1, 0);
    if ((end - start) * 1_000 >= 45_000 || spoken >= 600) flush();
  }
  flush();
  return dedupe(rows);
}

function buildSegment(startSeconds: number, endSeconds: number, rawText: string): AudioSegment {
  const text = rawText.slice(0, MAX_TEXT);
  const startMs = Math.min(MAX_AUDIO_MS, Math.round(startSeconds * 1_000));
  const endMs = Math.min(MAX_AUDIO_MS, Math.max(startMs, Math.round(endSeconds * 1_000)));
  return { id: `${startMs}-${endMs}-${text.slice(0, MAX_ID_TEXT)}`, startMs, endMs, text };
}

/**
 * `transcript_segments` is unique on (session_id, client_id), and two identical
 * sentences spoken in the same millisecond window would collide. Upsert would
 * silently keep one; dropping the duplicate here makes the count honest.
 */
function dedupe(rows: AudioSegment[]): AudioSegment[] {
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.id) && seen.add(row.id));
}

/**
 * Deepgram calls our callback with no credential of its own, so the upload id is
 * carried alongside an HMAC of itself. Without this, anyone who guessed the route
 * could post a fabricated transcript onto someone else's lecture.
 */
export function callbackToken(uploadId: string): string {
  const secret = process.env.LECTURE_AUDIO_CALLBACK_SECRET;
  if (!secret) throw new Error("LECTURE_AUDIO_CALLBACK_SECRET is not set");
  return createHmac("sha256", secret).update(uploadId).digest("hex");
}

export function callbackTokenMatches(uploadId: string, token: string): boolean {
  let expected: string;
  try {
    expected = callbackToken(uploadId);
  } catch {
    return false;
  }
  const given = Buffer.from(token, "utf8");
  const want = Buffer.from(expected, "utf8");
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * The prerecorded request. Deepgram fetches the audio itself from a short-lived
 * signed URL, so a 1GB lecture never passes through this server twice, and posts
 * the finished transcript back to `callbackUrl`.
 */
export function prerecordedUrl(options: { language: DeepgramLanguage; keyterms: string[]; callbackUrl: string; sessionId: string }): string {
  const params = new URLSearchParams({
    model: "nova-3",
    language: options.language,
    smart_format: "true",
    punctuate: "true",
    // Sentence boundaries with timings — the closest prerecorded equivalent to
    // what the live path builds out of speech_final.
    utterances: "true",
    mip_opt_out: "true",
    callback: options.callbackUrl,
    callback_method: "post",
    tag: `upload-${options.sessionId}`,
  });
  for (const term of keytermBudget(options.keyterms)) params.append("keyterm", term);
  return `https://api.deepgram.com/v1/listen?${params.toString()}`;
}
