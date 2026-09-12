import { NextResponse } from "next/server";
import OpenAI from "openai";

import { enqueueStorageDeletion, drainStorageDeletions } from "../../../lib/storage-cleanup";
import { reserveLectureIndex, finishLectureIndex } from "../../../lib/lecture-index-budget";

import { chunkTranscript } from "../../../lib/chunk-transcript";
import { isUuid } from "../../../lib/billing";
import {
  callbackTokenMatches,
  MAX_AUDIO_MS,
  segmentsFromPrerecorded,
  type PrerecordedResult,
} from "../../../lib/lecture-audio";
import { createAdminClient } from "../../../lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Where Deepgram posts a finished transcript (UPL-07). The caller is Deepgram,
 * not the learner, so there is no session cookie here: the upload id in the
 * query string is paired with an HMAC of itself, and the row is loaded with the
 * service key once that matches.
 *
 * Everything this route writes is scoped by ids read off that one row, never
 * off the request body — a valid token for one upload cannot be used to write
 * into another account's lecture.
 */
export async function POST(request: Request) {
  const params = new URL(request.url).searchParams;
  const uploadId = params.get("uploadId") ?? "";
  const token = params.get("token") ?? "";
  if (!isUuid(uploadId) || !token || !callbackTokenMatches(uploadId, token)) {
    // Deliberately vague: a probe should not learn whether the id exists.
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const supabase = createAdminClient();
  if (!supabase) {
    console.error("Lecture audio callback has no admin client");
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }

  const { data: upload } = await supabase
    .from("uploads")
    .select("id,session_id,user_id,object_key,status,duration_ms,provider_request_id")
    .eq("id", uploadId)
    .maybeSingle();
  if (!upload) return NextResponse.json({ error: "Not found." }, { status: 404 });

  // Deepgram retries a callback the receiver did not acknowledge. Re-running
  // would re-charge the lecture, so a finished upload just says yes again.
  if (upload.status === "completed" || upload.status === "failed") {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const { data: claimed, error: claimError } = await supabase.rpc("claim_audio_callback_service", { p_upload_id: upload.id });
  if (claimError || !claimed) return NextResponse.json({ error: "Callback is already processing." }, { status: 503 });
  const retry = async (message: string) => {
    await supabase.from("uploads").update({ callback_claimed_at: null }).eq("id", upload.id);
    return NextResponse.json({ error: message }, { status: 500 });
  };
  const discardAudio = async () => {
    if (upload.object_key) await enqueueStorageDeletion(supabase, {
      bucket: "lecture-audio", objectKey: upload.object_key, userId: upload.user_id, reason: "audio_finished",
    });
    await drainStorageDeletions(supabase, { limit: 5, userId: upload.user_id });
  };
  const markFailed = async (code: string) => {
    await discardAudio();
    await supabase.from("uploads").update({ status: "failed", error_code: code, updated_at: new Date().toISOString() }).eq("id", upload.id);
    await supabase.from("lecture_sessions").delete().eq("id", upload.session_id);
  };

  let payload: PrerecordedResult;
  try {
    payload = await request.json() as PrerecordedResult;
  } catch {
    await markFailed("payload");
    return NextResponse.json({ ok: true });
  }

  if (upload.provider_request_id && payload.metadata?.request_id && upload.provider_request_id !== payload.metadata.request_id) {
    return retry("Request mismatch.");
  }
  // The canonical file was fully decoded and its samples counted before
  // submission. Settle that exact processing time, including silent audio.
  // Charging only returned words lets repeated silent jobs consume free API work.
  const { data: charged, error: creditError } = await supabase.rpc("settle_audio_credits_service", {
    p_user_id: upload.user_id, p_upload_id: upload.id, p_charge: true,
  });
  if (creditError || !Number(charged)) return retry("Charge failed.");
  const durationMs = Math.min(MAX_AUDIO_MS, Number(upload.duration_ms));
  if (!Number.isFinite(durationMs) || durationMs <= 0) return retry("Verified duration missing.");
  const durationSeconds = Math.ceil(durationMs / 1_000);
  const paidSegments = segmentsFromPrerecorded(payload).filter(segment => segment.startMs < durationMs)
    .map(segment => ({ ...segment, endMs: Math.min(segment.endMs, durationMs) }));
  if (!paidSegments.length) {
    await markFailed("empty");
    return NextResponse.json({ ok: true });
  }
  const { data: session } = await supabase.from("lecture_sessions").select("id,classroom_id,user_id,status")
    .eq("id", upload.session_id).eq("user_id", upload.user_id).maybeSingle();
  if (!session) {
    await markFailed("session_gone");
    return NextResponse.json({ ok: true });
  }

  const { error: segmentError } = await supabase.from("transcript_segments").upsert(
    paidSegments.map((segment) => ({
      session_id: session.id,
      classroom_id: session.classroom_id,
      user_id: session.user_id,
      client_id: segment.id,
      start_ms: segment.startMs,
      end_ms: segment.endMs,
      text: segment.text,
    })),
    { onConflict: "session_id,client_id" },
  );
  if (segmentError) {
    console.error("Upload transcript save failed", segmentError.code);
    return retry("Transcript save failed.");
  }

  const { error: completeError } = await supabase
    .from("lecture_sessions")
    .update({ status: "completed", recorded_ms: durationMs, ended_at: new Date().toISOString(), duration_seconds: Math.min(10_800, durationSeconds) })
    .eq("id", session.id);
  if (completeError) return retry("Session completion failed.");

  await indexUpload(supabase, session, paidSegments);
  await discardAudio();
  await supabase
    .from("uploads")
    .update({
      status: "completed",
      duration_ms: durationMs,
      updated_at: new Date().toISOString(),
    })
    .eq("id", upload.id);

  return NextResponse.json({ ok: true });
}

/**
 * The same embedding step `/api/lecture-sessions` runs when a live lecture
 * ends — without it the upload is stored but `match_lecture_chunks` can never
 * find it, so a later question would not see this lecture at all (UPL-07).
 *
 * A failure here is logged, not fatal: the transcript is already saved and the
 * learner can read it. Reconcile's catch-up pass picks up an unindexed lecture
 * on a later visit.
 */
async function indexUpload(
  supabase: NonNullable<ReturnType<typeof createAdminClient>>,
  session: { id: string; classroom_id: string | null; user_id: string },
  segments: Array<{ startMs: number; endMs: number; text: string }>,
) {
  if (!process.env.OPENAI_API_KEY) return;
  const chunks = chunkTranscript(segments);
  if (!chunks.length) return;

  const claimToken = await reserveLectureIndex(supabase, {
    sessionId: session.id, userId: session.user_id, characters: chunks.reduce((total, chunk) => total + chunk.text.length, 0),
  });
  if (!claimToken) return;
  let succeeded = false;
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 0 });
    const created = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunks.map((chunk) => chunk.text),
    });
    // The API echoes an index per row; trusting array order would file one part
    // of the lecture under another part's vector.
    const embeddings = [...created.data].sort((a, b) => a.index - b.index);
    await supabase.from("lecture_chunks").delete().eq("session_id", session.id);
    const { error } = await supabase.from("lecture_chunks").insert(chunks.map((chunk, index) => ({
      session_id: session.id,
      classroom_id: session.classroom_id,
      user_id: session.user_id,
      start_ms: chunk.startMs,
      end_ms: chunk.endMs,
      text: chunk.text,
      embedding: embeddings[index].embedding,
    })));
    if (error) throw error;
    succeeded = true;
  } catch (error) {
    console.error("Upload indexing failed", error && typeof error === "object" && "code" in error ? error.code : "unknown");
  } finally {
    await finishLectureIndex(supabase, session.id, claimToken, succeeded);
  }
}
