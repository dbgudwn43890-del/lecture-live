import { NextResponse } from "next/server";
import OpenAI from "openai";

import { chunkTranscript, type TranscriptPart } from "../../lib/chunk-transcript";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

/** One lecture's hard cap. Past this a "recording" row cannot still be live. */
const MAX_LECTURE_MS = 10_800_000;

type SegmentBody = TranscriptPart & { id?: unknown };
type SegmentRow = { client_id: string; start_ms: number; end_ms: number; text: string };

// PostgREST silently caps a single select at 1,000 rows no matter what
// `.limit()` says. A 3-hour lecture can produce many more transcript segments
// than that, so any full-transcript read has to page through with `.range()`
// or the tail of a long lecture comes back missing without any error.
const SEGMENT_PAGE_SIZE = 1_000;

async function fetchAllSegments(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  maxRows: number,
): Promise<{ rows: SegmentRow[]; error?: undefined } | { rows?: undefined; error: { code?: string } }> {
  const rows: SegmentRow[] = [];
  let from = 0;
  while (rows.length < maxRows) {
    const to = Math.min(from + SEGMENT_PAGE_SIZE, maxRows) - 1;
    const { data, error } = await supabase
      .from("transcript_segments")
      .select("client_id,start_ms,end_ms,text")
      .eq("session_id", sessionId)
      // start_ms is not unique, and a paginated read needs a total order or
      // rows that share a timestamp can straddle a page boundary and be
      // repeated or skipped. client_id is unique per session.
      .order("start_ms")
      .order("client_id")
      .range(from, to);
    if (error) return { error };
    rows.push(...(data ?? []));
    if (!data || data.length < to - from + 1) break; // fewer rows than requested: reached the end
    from += SEGMENT_PAGE_SIZE;
  }
  return { rows };
}

type IndexInput = { sessionId: string; classroomId: string | null; userId: string; segments: TranscriptPart[] };

// Shared by the PATCH completion path and the reconcile recovery path: turns
// saved transcript segments into `lecture_chunks` rows so
// `match_lecture_chunks` (used by /api/ask's findEarlierLectureContext) can
// find the lecture. A lecture closed by reconcile needs the exact same
// indexing a normal "end lecture" gets, or its data is stored but never
// searchable.
//
// Indexing failures are logged and swallowed per session — a lecture that
// fails to embed still ends up "completed" (the caller already committed
// that); it just stays un-searchable until a later attempt indexes it.
async function indexLectureChunks(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessions: IndexInput[],
): Promise<Map<string, boolean>> {
  const indexed = new Map<string, boolean>();
  if (!process.env.OPENAI_API_KEY) return indexed;

  const batches = sessions
    .map((session) => ({ session, chunks: chunkTranscript(session.segments) }))
    .filter((entry) => entry.chunks.length > 0);
  if (!batches.length) return indexed;

  // ponytail: one embeddings.create call for the whole batch instead of one
  // per session — reconcile can carry several sessions in a single request,
  // and issuing that many sequential OpenAI calls would make one reconcile
  // request take minutes. A single call scales with total transcript size,
  // not with session count.
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 });
  let embeddings: Awaited<ReturnType<typeof openai.embeddings.create>>;
  try {
    embeddings = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: batches.flatMap((entry) => entry.chunks.map((chunk) => chunk.text)),
    });
    // One call now carries chunks from several lectures, so a response that
    // came back out of order would file one lecture's text under another
    // lecture's vector. Sort by the index the API echoes back rather than
    // trusting array position.
    embeddings.data = [...embeddings.data].sort((a, b) => a.index - b.index);
  } catch (error) {
    console.error("Lecture indexing embedding call failed", error && typeof error === "object" && "code" in error ? error.code : "unknown");
    return indexed;
  }

  let offset = 0;
  for (const entry of batches) {
    const { session, chunks } = entry;
    const rows = chunks.map((chunk, i) => ({
      session_id: session.sessionId,
      classroom_id: session.classroomId,
      user_id: session.userId,
      start_ms: chunk.startMs,
      end_ms: chunk.endMs,
      text: chunk.text,
      embedding: embeddings.data[offset + i].embedding,
    }));
    offset += chunks.length;
    try {
      await supabase.from("lecture_chunks").delete().eq("session_id", session.sessionId);
      const { error } = await supabase.from("lecture_chunks").insert(rows);
      if (error) throw error;
      indexed.set(session.sessionId, true);
    } catch (error) {
      console.error("Lecture indexing save failed", error && typeof error === "object" && "code" in error ? error.code : "unknown");
    }
  }
  return indexed;
}

async function context(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!user) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  // Every verb goes through here, so one ceiling covers them all. A lecture
  // saves a segment every few seconds, so the limit is loose — it exists to
  // bound a loop, not to pace a recording.
  const rateLimit = await checkSharedRateLimit(`lecture-sessions:${user.id}`, 240, 60_000);
  if (!rateLimit.allowed) {
    return { response: NextResponse.json(
      { error: isEnglish ? "Too many requests. Try again shortly." : "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    ) };
  }
  return { userId: user.id, supabase, isEnglish };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
}

function validSegment(value: unknown): value is SegmentBody & { id: string } {
  if (!value || typeof value !== "object") return false;
  const segment = value as Record<string, unknown>;
  return typeof segment.id === "string" && segment.id.length <= 2_200
    && typeof segment.startMs === "number" && segment.startMs >= 0 && segment.startMs <= 10_800_000
    && typeof segment.endMs === "number" && segment.endMs >= segment.startMs && segment.endMs <= 10_800_000
    && typeof segment.text === "string" && segment.text.trim().length > 0 && segment.text.length <= 2_000;
}

export async function GET(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!validId(sessionId)) return NextResponse.json({ error: current.isEnglish ? "Check the lecture ID." : "수업 ID를 확인해 주세요." }, { status: 400 });

  // ponytail: 50,000 segments is far beyond any real lecture (individual
  // "segment" saves during recording are never capped like the PATCH
  // completion payload is) — it's just a safety ceiling against a runaway read.
  const [{ data: session, error: sessionError }, { rows: segments, error: segmentError }, { data: questions, error: questionError }] = await Promise.all([
    current.supabase.from("lecture_sessions").select("id,classroom_id,title,status,started_at,ended_at,duration_seconds").eq("id", sessionId).maybeSingle(),
    fetchAllSegments(current.supabase, sessionId, 50_000),
    current.supabase.from("lecture_questions").select("id,question,answer,provider,model,external_sources,lecture_sources,created_at").eq("session_id", sessionId).order("created_at"),
  ]);

  if (sessionError || segmentError || questionError || !session) {
    if (sessionError || segmentError || questionError) console.error("Lecture read failed", sessionError?.code ?? segmentError?.code ?? questionError?.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not load the lecture." : "수업 기록을 불러오지 못했습니다." }, { status: 404 });
  }

  return NextResponse.json({ session, segments: (segments ?? []).map((segment) => ({ id: segment.client_id, startMs: segment.start_ms, endMs: segment.end_ms, text: segment.text })), questions: questions ?? [] });
}

export async function POST(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  let body: { action?: unknown; classroomId?: unknown; sessionId?: unknown; title?: unknown; segment?: unknown; latencyMs?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: current.isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  if (body.action === "start" || body.action === "draft") {
    const classroomId = validId(body.classroomId) ? body.classroomId : null;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 80) return NextResponse.json({ error: current.isEnglish ? "Check the lecture title." : "수업 제목을 확인해 주세요." }, { status: 400 });
    if (body.classroomId !== null && body.classroomId !== undefined && body.classroomId !== "" && !classroomId) {
      return NextResponse.json({ error: current.isEnglish ? "Check the classroom." : "강의실을 확인해 주세요." }, { status: 400 });
    }
    if (classroomId) {
      const { data: classroom } = await current.supabase.from("classrooms").select("id").eq("id", classroomId).maybeSingle();
      if (!classroom) return NextResponse.json({ error: current.isEnglish ? "Classroom not found." : "강의실을 찾지 못했습니다." }, { status: 404 });
    }

    const draftId = body.action === "start" && validId(body.sessionId) ? body.sessionId : null;
    const query = draftId
      ? current.supabase.from("lecture_sessions").update({ status: "recording", started_at: new Date().toISOString() }).eq("id", draftId).eq("status", "draft")
      : current.supabase.from("lecture_sessions").insert({ classroom_id: classroomId, user_id: current.userId, title, status: body.action === "draft" ? "draft" : "recording" });
    const { data, error } = await query.select("id,classroom_id,title,status,started_at,ended_at,duration_seconds").single();
    if (error) {
      console.error("Lecture start save failed", error.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not create the lecture record." : "수업 기록을 만들지 못했습니다." }, { status: 500 });
    }
    const sessionClassroomId = data.classroom_id;
    if (sessionClassroomId) {
      const [, { error: claimError }] = await Promise.all([
        current.supabase.from("classrooms").update({ updated_at: new Date().toISOString() }).eq("id", sessionClassroomId),
        // 방금 올린 자료는 지금 시작하는 수업의 것이다. 지난주 자료는 이미 그때의
        // 세션을 달고 있으므로 여기 걸리지 않는다. 이 구분이 있어야 keyterm 예산이
        // 한 학기치 PDF가 아니라 오늘 강의의 어휘로 찬다.
        current.supabase
          .from("material_documents")
          .update({ session_id: data.id })
          .eq("classroom_id", sessionClassroomId)
          .is("session_id", null),
      ]);
      // 자료가 안 붙어도 수업은 시작돼야 한다. keyterm은 강의실 전체 자료로
      // 물러나므로 최악이라도 지금과 같다.
      if (claimError) console.error("Material session claim failed", claimError.code);
    }
    return NextResponse.json({ session: data }, { status: 201 });
  }

  // A refresh or crash mid-lecture used to leave the row in "recording"
  // forever: the library showed it as live and the workspace opened it at
  // 0:00. Only sessions past the 3-hour cap are closed — a session younger
  // than that may be recording right now in another tab, and completing it
  // would make every further audio chunk fail with LECTURE_NOT_RECORDING.
  if (body.action === "reconcile") {
    // ponytail: batch size this reconcile call closes in one request. If we
    // fill it, more stale sessions likely remain — say so in the response
    // instead of quietly leaving them for a caller that never checks again.
    const MAX_RECONCILE_SESSIONS = 20;
    // ponytail: cap on total chunks embedded per reconcile call. Batching all
    // sessions into one OpenAI call (see indexLectureChunks) keeps this fast
    // in the normal case, but a pile of stale 3-hour lectures could still add
    // up to a huge combined input. Sessions beyond the cap stay "completed"
    // without chunks — same outcome as the bug this fixes for those specific
    // sessions — but the response reports it instead of hiding it, so this is
    // a rare, visible edge case rather than a silent, permanent one.
    const MAX_RECONCILE_CHUNKS = 1_000;
    // ponytail: how far back to look for a completed lecture that never got
    // indexed. A window rather than "all of them" because a lecture whose
    // transcript is genuinely empty produces no chunks and would otherwise be
    // re-checked on every page load forever. A week is long enough to cover a
    // deferred batch or an OpenAI outage and short enough to stop retrying.
    const INDEX_CATCH_UP_MS = 7 * 86_400_000;

    const abandonedBefore = new Date(Date.now() - MAX_LECTURE_MS).toISOString();
    const { data: stale, error } = await current.supabase
      .from("lecture_sessions")
      .select("id,classroom_id,user_id")
      .eq("status", "recording")
      .lt("started_at", abandonedBefore)
      .limit(MAX_RECONCILE_SESSIONS);
    if (error) {
      console.error("Stale lecture lookup failed", error.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not check earlier lectures." : "지난 수업을 확인하지 못했습니다." }, { status: 500 });
    }

    const toIndex: IndexInput[] = [];
    for (const session of stale ?? []) {
      // The client never sends segments for a session it didn't close itself,
      // so read the transcript straight from the table — paginated, because a
      // 3-hour lecture has far more than PostgREST's 1,000-row default cap.
      const { rows: segments, error: segmentsError } = await fetchAllSegments(current.supabase, session.id, 5_000);
      if (segmentsError) console.error("Reconcile transcript read failed", segmentsError.code);

      const durationSeconds = segments?.length ? Math.round(Math.max(...segments.map((row) => row.end_ms)) / 1_000) : 0;
      await current.supabase
        .from("lecture_sessions")
        .update({
          status: "completed",
          ended_at: new Date().toISOString(),
          duration_seconds: durationSeconds,
        })
        .eq("id", session.id);

      if (segments?.length) {
        toIndex.push({
          sessionId: session.id,
          classroomId: session.classroom_id,
          userId: session.user_id,
          segments: segments.map((row) => ({ startMs: row.start_ms, endMs: row.end_ms, text: row.text })),
        });
      }
    }

    // A completed lecture with no chunks never comes back through the stale
    // branch above — its status is no longer "recording" — so an indexing run
    // that failed or was deferred left it permanently unsearchable. Pick those
    // up here instead.
    const catchUpAfter = new Date(Date.now() - INDEX_CATCH_UP_MS).toISOString();
    const { data: recent, error: recentError } = await current.supabase
      .from("lecture_sessions")
      .select("id,classroom_id,user_id")
      .eq("status", "completed")
      .gt("ended_at", catchUpAfter)
      .gt("duration_seconds", 0)
      .order("ended_at", { ascending: false })
      .limit(MAX_RECONCILE_SESSIONS);
    if (recentError) console.error("Indexing catch-up lookup failed", recentError.code);

    const closedNow = new Set(toIndex.map((entry) => entry.sessionId));
    const candidates = (recent ?? []).filter((session) => !closedNow.has(session.id));
    if (candidates.length) {
      // Check for chunks before reading transcripts: the point of the catch-up
      // is the handful with none, and reading every recent lecture's segments
      // to discover that would cost far more than it saves.
      const { data: chunked } = await current.supabase
        .from("lecture_chunks")
        .select("session_id")
        .in("session_id", candidates.map((session) => session.id));
      const hasChunks = new Set((chunked ?? []).map((row) => row.session_id));
      for (const session of candidates) {
        if (hasChunks.has(session.id)) continue;
        const { rows: segments, error: segmentsError } = await fetchAllSegments(current.supabase, session.id, 5_000);
        if (segmentsError) {
          console.error("Catch-up transcript read failed", segmentsError.code);
          continue;
        }
        if (segments?.length) {
          toIndex.push({
            sessionId: session.id,
            classroomId: session.classroom_id,
            userId: session.user_id,
            segments: segments.map((row) => ({ startMs: row.start_ms, endMs: row.end_ms, text: row.text })),
          });
        }
      }
    }

    let indexedCount = 0;
    let indexingDeferred = 0;
    if (toIndex.length) {
      // Don't re-embed a session that somehow already has chunks (e.g. a
      // concurrent reconcile call raced this one for the same stale session).
      const { data: existingChunks } = await current.supabase
        .from("lecture_chunks")
        .select("session_id")
        .in("session_id", toIndex.map((entry) => entry.sessionId));
      const alreadyIndexed = new Set((existingChunks ?? []).map((row) => row.session_id));
      const pending = toIndex.filter((entry) => !alreadyIndexed.has(entry.sessionId));

      const batch: IndexInput[] = [];
      let usedChunks = 0;
      for (const entry of pending) {
        const chunkCount = chunkTranscript(entry.segments).length;
        if (batch.length && usedChunks + chunkCount > MAX_RECONCILE_CHUNKS) {
          indexingDeferred += 1;
          continue;
        }
        batch.push(entry);
        usedChunks += chunkCount;
      }
      if (indexingDeferred > 0) console.warn("Reconcile deferred indexing for", indexingDeferred, "session(s) past the chunk cap");

      if (batch.length) {
        const indexResult = await indexLectureChunks(current.supabase, batch);
        indexedCount = [...indexResult.values()].filter(Boolean).length;
      }
    }

    const reconciled = stale?.length ?? 0;
    return NextResponse.json({
      reconciled,
      indexed: indexedCount,
      indexingDeferred,
      // Batch was full: there may be more stale sessions this call didn't
      // reach. The client can use this to decide whether to call again.
      hasMore: reconciled === MAX_RECONCILE_SESSIONS,
    });
  }

  if (body.action === "segment" && validId(body.sessionId) && validSegment(body.segment)) {
    const segment = body.segment;
    // The browser holds the Deepgram socket directly, so this save is the only
    // event the server sees on a live lecture — which makes it the only place
    // the meter can run. The minute index comes from the session's own
    // started_at, so the client cannot supply it, and consumption is idempotent
    // per minute, so several utterances inside one minute bill it once.
    const [{ data: creditData, error: creditError }, { data: session }] = await Promise.all([
      current.supabase.rpc("consume_lecture_credits_elapsed", { p_session_id: body.sessionId }),
      current.supabase.from("lecture_sessions").select("classroom_id").eq("id", body.sessionId).maybeSingle(),
    ]);
    if (!session) return NextResponse.json({ error: current.isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });
    if (creditError) {
      console.error("Credit consumption failed", creditError.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not use credits for this lecture." : "이 수업의 크레딧을 차감하지 못했습니다." }, { status: 409 });
    }
    const credit = Array.isArray(creditData) ? creditData[0] : creditData;
    if (!credit?.allowed) {
      return NextResponse.json({
        error: current.isEnglish ? "You are out of credits. Choose a plan to continue." : "남은 크레딧이 없습니다. 요금제를 선택해 주세요.",
        credits: Number(credit?.remaining_credits ?? 0),
      }, { status: 402 });
    }
    const { error } = await current.supabase.from("transcript_segments").upsert({
      session_id: body.sessionId,
      classroom_id: session.classroom_id,
      user_id: current.userId,
      client_id: segment.id,
      start_ms: Math.round(segment.startMs),
      end_ms: Math.round(segment.endMs),
      text: segment.text.trim(),
      // Measured by the client around the transcription call, so the pilot can
      // see the STT round trip per segment rather than guessing (PRD 36.3.4).
      latency_ms: typeof body.latencyMs === "number" && Number.isFinite(body.latencyMs)
        ? Math.min(600_000, Math.max(0, Math.round(body.latencyMs)))
        : null,
    }, { onConflict: "session_id,client_id" });
    if (error) {
      console.error("Transcript segment save failed", error.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not save the transcript." : "스크립트를 저장하지 못했습니다." }, { status: 500 });
    }
    return NextResponse.json({ saved: true });
  }

  return NextResponse.json({ error: current.isEnglish ? "Invalid lecture request." : "수업 요청을 확인해 주세요." }, { status: 400 });
}

/**
 * HIS-03/HIS-04. Every child table (`transcript_segments`, `lecture_chunks`,
 * `lecture_questions`, `lecture_reports`, `material_documents`) declares
 * `references lecture_sessions(id) on delete cascade`, so one delete takes the
 * lecture and everything derived from it. RLS scopes the row to its owner, so
 * a guessed id from another account deletes nothing and reports "not found"
 * rather than confirming the lecture exists.
 *
 * A lecture that is still recording is deletable too. Refusing would leave a
 * session that crashed mid-lecture undeletable until reconcile closes it three
 * hours later; the client stops its own recording first, and a segment save
 * that races the delete already handles the 404.
 */
export async function DELETE(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!validId(sessionId)) {
    return NextResponse.json({ error: current.isEnglish ? "Check the lecture ID." : "수업 ID를 확인해 주세요." }, { status: 400 });
  }

  const { data: materials } = await current.supabase
    .from("material_documents")
    .select("storage_path")
    .eq("session_id", sessionId);
  const { data: deleted, error } = await current.supabase
    .from("lecture_sessions")
    .delete()
    .eq("id", sessionId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("Lecture delete failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not delete this lecture." : "이 수업을 삭제하지 못했습니다." }, { status: 500 });
  }
  if (!deleted) {
    return NextResponse.json({ error: current.isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });
  }
  const storagePaths = (materials ?? []).flatMap((material) => material.storage_path ? [material.storage_path] : []);
  if (storagePaths.length) {
    const { error: removeError } = await current.supabase.storage.from("materials").remove(storagePaths);
    if (removeError) console.error("Lecture material files remove failed", removeError.message);
  }
  return NextResponse.json({ deleted: true });
}

export async function PATCH(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  let body: { action?: unknown; sessionId?: unknown; classroomId?: unknown; title?: unknown; durationMs?: unknown; segments?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: current.isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }
  if (body.action === "rename" && validId(body.sessionId)) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 80) return NextResponse.json({ error: current.isEnglish ? "Check the lecture title." : "수업 이름을 확인해 주세요." }, { status: 400 });
    const { data: renamed, error } = await current.supabase.from("lecture_sessions").update({ title }).eq("id", body.sessionId).select("id").maybeSingle();
    if (error || !renamed) {
      if (error) console.error("Lecture rename failed", error.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not rename the lecture." : "수업 이름을 바꾸지 못했습니다." }, { status: 500 });
    }
    return NextResponse.json({ renamed: true, title });
  }

  if (body.action === "move" && validId(body.sessionId)) {
    const classroomId = validId(body.classroomId) ? body.classroomId : null;
    if (body.classroomId !== null && body.classroomId !== "" && body.classroomId !== undefined && !classroomId) {
      return NextResponse.json({ error: current.isEnglish ? "Check the destination classroom." : "이동할 강의실을 확인해 주세요." }, { status: 400 });
    }
    if (classroomId) {
      const { data: classroom } = await current.supabase.from("classrooms").select("id").eq("id", classroomId).maybeSingle();
      if (!classroom) return NextResponse.json({ error: current.isEnglish ? "Classroom not found." : "강의실을 찾지 못했습니다." }, { status: 404 });
    }
    const { data: moved, error: moveError } = await current.supabase.rpc("move_lecture_session", {
      p_session_id: body.sessionId,
      p_classroom_id: classroomId,
    });
    if (moveError || !moved) {
      if (moveError) console.error("Lecture move failed", moveError.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not move the lecture." : "수업을 이동하지 못했습니다." }, { status: 500 });
    }
    return NextResponse.json({ moved: true, classroomId });
  }

  if (!validId(body.sessionId) || typeof body.durationMs !== "number" || !Array.isArray(body.segments)) {
    return NextResponse.json({ error: current.isEnglish ? "Invalid lecture completion data." : "수업 종료 정보를 확인해 주세요." }, { status: 400 });
  }
  const segments = body.segments.filter(validSegment).slice(0, 5_000);
  const { data: session } = await current.supabase.from("lecture_sessions").select("id,classroom_id,started_at,status").eq("id", body.sessionId).maybeSingle();
  if (!session) return NextResponse.json({ error: current.isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });
  // Only a recording lecture can be completed. consume_lecture_credits already
  // refuses anything else, but that rejection was logged and stepped over, so a
  // completed session could be re-PATCHed forever — each replay re-embedding a
  // fresh 5,000-segment payload on the platform key. Ending twice is a no-op.
  if (session.status !== "recording") return NextResponse.json({ completed: true, indexed: false });

  if (segments.length) {
    const { error } = await current.supabase.from("transcript_segments").upsert(segments.map((segment) => ({
      session_id: body.sessionId,
      classroom_id: session.classroom_id,
      user_id: current.userId,
      client_id: segment.id,
      start_ms: Math.round(segment.startMs),
      end_ms: Math.round(segment.endMs),
      text: segment.text.trim(),
    })), { onConflict: "session_id,client_id" });
    if (error) console.error("Final transcript save failed", error.code);
  }

  // Derived from the session's own started_at, not from the client. A client
  // reporting durationMs: 0 after a 90-minute lecture used to store 0 and skip
  // the final credit reconciliation below.
  const elapsedMs = Date.now() - new Date(session.started_at).getTime();
  // A start that failed before the first sample (a blocked AudioContext, a
  // missing worklet) still lands here, and billing off started_at charged it a
  // full lecture-minute for a lecture that recorded nothing. The transcript is
  // counted in the database rather than taken from durationMs, so a client
  // under-reporting a real 90-minute lecture still reconciles.
  const { count: storedSegments } = await current.supabase
    .from("transcript_segments")
    .select("id", { count: "exact", head: true })
    .eq("session_id", body.sessionId);
  const recordedSomething = segments.length > 0 || (storedSegments ?? 0) > 0;
  const durationSeconds = recordedSomething ? Math.min(10_800, Math.max(0, Math.ceil(elapsedMs / 1_000))) : 0;
  if (durationSeconds > 0) {
    const { error: creditError } = await current.supabase.rpc("consume_lecture_credits", {
      p_session_id: body.sessionId,
      p_minute_index: Math.min(179, Math.max(0, Math.ceil(durationSeconds / 60) - 1)),
    });
    if (creditError) console.error("Final credit reconciliation failed", creditError.code);
  }
  const { error: updateError } = await current.supabase.from("lecture_sessions").update({ status: "completed", ended_at: new Date().toISOString(), duration_seconds: durationSeconds }).eq("id", body.sessionId);
  if (updateError) {
    console.error("Lecture completion failed", updateError.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not finish saving the lecture." : "수업 저장을 마치지 못했습니다." }, { status: 500 });
  }

  const indexResult = await indexLectureChunks(current.supabase, [{
    sessionId: body.sessionId,
    classroomId: session.classroom_id,
    userId: current.userId,
    segments,
  }]);
  const indexed = indexResult.get(body.sessionId) ?? false;

  return NextResponse.json({ completed: true, indexed });
}
