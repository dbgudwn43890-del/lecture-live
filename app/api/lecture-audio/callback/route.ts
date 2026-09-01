import { NextResponse } from "next/server";
import OpenAI from "openai";

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
    .select("id,session_id,user_id,object_key,status")
    .eq("id", uploadId)
    .maybeSingle();
  if (!upload) return NextResponse.json({ error: "Not found." }, { status: 404 });

  // Deepgram retries a callback the receiver did not acknowledge. Re-running
  // would re-charge the lecture, so a finished upload just says yes again.
  if (upload.status === "completed" || upload.status === "failed") {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const discardAudio = async () => {
    if (!upload.object_key) return;
    // UPL-05/PRD 5.4. The transcript exists now, so the recording has no
    // remaining purpose — it goes as soon as the transcript is saved, not on
    // the 24-hour deadline that only covers failures.
    const { error } = await supabase.storage.from("lecture-audio").remove([upload.object_key]);
    if (error) console.error("Audio remove failed", error.message);
  };

  const markFailed = async (code: string) => {
    await discardAudio();
    await supabase
      .from("uploads")
      .update({ status: "failed", error_code: code, object_key: null, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", upload.id);
    // The session was only ever a container for this transcript.
    await supabase.from("lecture_sessions").delete().eq("id", upload.session_id);
  };

  let payload: PrerecordedResult;
  try {
    payload = await request.json() as PrerecordedResult;
  } catch {
    await markFailed("payload");
    return NextResponse.json({ ok: true });
  }

  const segments = segmentsFromPrerecorded(payload);
  if (!segments.length) {
    // Silence, music, or a language the model could not read. Nothing to store
    // and nothing to charge for.
    await markFailed("empty");
    return NextResponse.json({ ok: true });
  }

  const { data: session } = await supabase
    .from("lecture_sessions")
    .select("id,classroom_id,user_id,status")
    .eq("id", upload.session_id)
    .maybeSingle();
  if (!session) {
    // The learner deleted the lecture while it was transcribing. Their choice
    // stands: drop the audio and stop.
    await markFailed("session_gone");
    return NextResponse.json({ ok: true });
  }

  const { error: segmentError } = await supabase.from("transcript_segments").upsert(
    segments.map((segment) => ({
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
    await markFailed("save");
    return NextResponse.json({ ok: true });
  }

  // Length comes from Deepgram, never from the browser: the client's estimate
  // gates acceptance, this decides the bill. Falling back to the last segment
  // keeps a response without metadata from billing zero.
  const measuredSeconds = Number(payload.metadata?.duration);
  const durationMs = Math.min(
    MAX_AUDIO_MS,
    Number.isFinite(measuredSeconds) && measuredSeconds > 0
      ? Math.round(measuredSeconds * 1_000)
      : segments.at(-1)?.endMs ?? 0,
  );
  const durationSeconds = Math.max(1, Math.ceil(durationMs / 1_000));

  // BILL-01, on the same meter as a live lecture: one started minute, one
  // credit. The owner comes from the session row rather than auth.uid(), which
  // is null on this service-key connection — the cookie-bound RPC raised
  // AUTH_REQUIRED here and every upload went out unbilled. The service variant
  // is idempotent per minute, so a retried callback cannot double-charge.
  const { data: charge, error: creditError } = await supabase.rpc("consume_lecture_credits_service", {
    p_user_id: session.user_id,
    p_session_id: session.id,
    p_minute_index: Math.min(179, Math.max(0, Math.ceil(durationSeconds / 60) - 1)),
  });
  if (creditError) {
    // A retry that arrives after an earlier attempt charged and completed the
    // session raises LECTURE_NOT_RECORDING. The money is already taken —
    // failing forever here would just make Deepgram hammer the callback.
    if (String(creditError.message ?? "").includes("LECTURE_NOT_RECORDING")) {
      console.error("Upload charge skipped, session already closed", upload.id);
    } else {
      // Nothing here is written yet beyond the transcript, and the charge is
      // idempotent — let Deepgram retry rather than lose the money silently.
      console.error("Upload credit charge failed", creditError.code);
      return NextResponse.json({ error: "Charge failed." }, { status: 500 });
    }
  }
  // Out of credits mid-upload. The transcript already exists and the preflight
  // gated the start, so the lecture still completes; the shortfall is logged.
  if (Array.isArray(charge) && charge[0] && charge[0].allowed === false) {
    console.error("Upload credit charge partial", upload.id, charge[0].charged_through);
  }

  const { error: completeError } = await supabase
    .from("lecture_sessions")
    .update({ status: "completed", ended_at: new Date().toISOString(), duration_seconds: Math.min(10_800, durationSeconds) })
    .eq("id", session.id);
  if (completeError) console.error("Upload session completion failed", completeError.code);

  await indexUpload(supabase, session, segments);
  await discardAudio();
  await supabase
    .from("uploads")
    .update({
      status: "completed",
      duration_ms: durationMs,
      object_key: null,
      deleted_at: new Date().toISOString(),
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

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 1 });
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
  } catch (error) {
    console.error("Upload indexing failed", error && typeof error === "object" && "code" in error ? error.code : "unknown");
  }
}
