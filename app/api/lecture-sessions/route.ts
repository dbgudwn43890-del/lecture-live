import { after, NextResponse } from "next/server";
import { hasVerifiedEmail } from "../../lib/verified-email";
import OpenAI from "openai";

import { isUuid } from "../../lib/billing";
import { chunkTranscript, type TranscriptPart } from "../../lib/chunk-transcript";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createAdminClient } from "../../lib/supabase/admin";
import { createClient } from "../../lib/supabase/server";
import { reserveLectureIndex, finishLectureIndex } from "../../lib/lecture-index-budget";
import { drainStorageDeletions } from "../../lib/storage-cleanup";

export const runtime = "nodejs";

/** One lecture's hard cap. Past this a "recording" row cannot still be live. */
const MAX_LECTURE_MS = 10_800_000;

const SESSION_COLUMNS = "id,classroom_id,title,status,started_at,ended_at,duration_seconds,recorded_ms,input_source";
const INPUT_SOURCES = ["microphone", "browser-tab"] as const;
type InputSource = (typeof INPUT_SOURCES)[number];

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
  if (rows.length === maxRows) {
    const { data, error } = await supabase.from("transcript_segments").select("client_id")
      .eq("session_id", sessionId).order("start_ms").order("client_id").range(maxRows, maxRows);
    if (error) return { error };
    if (data?.length) return { error: { code: "TRANSCRIPT_LIMIT" } };
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
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  sessions: IndexInput[],
): Promise<Map<string, boolean>> {
  const indexed = new Map<string, boolean>();
  if (!process.env.OPENAI_API_KEY) return indexed;

  const batches: Array<{ session: IndexInput; chunks: TranscriptPart[]; token: string }> = [];
  for (const session of sessions) {
    const chunks = chunkTranscript(session.segments);
    if (!chunks.length) continue;
    const token = await reserveLectureIndex(admin, {
      sessionId: session.sessionId, userId: session.userId,
      characters: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
    });
    if (token) batches.push({ session, chunks, token });
  }
  if (!batches.length) return indexed;

  // ponytail: one embeddings.create call for the whole batch instead of one
  // per session — reconcile can carry several sessions in a single request,
  // and issuing that many sequential OpenAI calls would make one reconcile
  // request take minutes. A single call scales with total transcript size,
  // not with session count.
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 0 });
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
    if (embeddings.data.length !== batches.reduce((sum, entry) => sum + entry.chunks.length, 0)
      || embeddings.data.some((row, index) => row.index !== index || !Array.isArray(row.embedding))) {
      throw new Error("Invalid lecture embeddings");
    }
  } catch (error) {
    console.error("Lecture indexing embedding call failed", error && typeof error === "object" && "code" in error ? error.code : "unknown");
    await Promise.all(batches.map(({ session, token }) => finishLectureIndex(admin, session.sessionId, token, false)));
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
      // Replace only after every vector exists. A failed insert or a recovered
      // tail rolls back the replacement and retains the previous usable index.
      const { data: replaced, error } = await admin.rpc("replace_lecture_index_service", {
        p_session_id: session.sessionId, p_user_id: session.userId,
        p_claim_token: entry.token, p_segment_count: session.segments.length,
        p_chunks: rows.map((row) => ({ ...row, embedding: JSON.stringify(row.embedding) })),
      });
      if (error) throw error;
      indexed.set(session.sessionId, replaced === true);
    } catch (error) {
      console.error("Lecture indexing save failed", error && typeof error === "object" && "code" in error ? error.code : "unknown");
      await finishLectureIndex(admin, session.sessionId, entry.token, false);
    }
  }
  return indexed;
}

function scheduleLectureIndex(admin: NonNullable<ReturnType<typeof createAdminClient>>, userId: string, sessionIds: string[]) {
  if (!sessionIds.length) return;
  after(async () => {
    for (const sessionId of sessionIds) {
      try {
        // Rotate failed/limited work so one old job cannot starve newer saves.
        await admin.from("lecture_index_queue").update({ updated_at: new Date().toISOString() })
          .eq("session_id", sessionId).eq("user_id", userId).eq("state", "pending");
        const { data: session, error } = await admin.from("lecture_sessions").select("id,classroom_id,status")
          .eq("id", sessionId).eq("user_id", userId).maybeSingle();
        if (error || !session || session.status !== "completed") continue;
        const { rows, error: readError } = await fetchAllSegments(admin, sessionId, 50_000);
        if (readError || !rows.length) continue;
        await indexLectureChunks(admin, [{ sessionId, userId, classroomId: session.classroom_id,
          segments: rows.map((row) => ({ startMs: row.start_ms, endMs: row.end_ms, text: row.text })) }]);
      } catch (error) {
        console.error("Deferred lecture indexing failed", error && typeof error === "object" && "code" in error ? error.code : "unknown");
      }
    }
  });
}

async function context(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (authError || !hasVerifiedEmail(user)) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
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
  // 예전 정규식은 하이픈 27개짜리 문자열도 통과시켜 Postgres 캐스팅 500을 냈다.
  return isUuid(value);
}

function validSegment(value: unknown): value is SegmentBody & { id: string } {
  if (!value || typeof value !== "object") return false;
  const segment = value as Record<string, unknown>;
  return typeof segment.id === "string" && segment.id.length > 0 && segment.id.length <= 2_200
    && typeof segment.startMs === "number" && Number.isFinite(segment.startMs) && segment.startMs >= 0 && segment.startMs <= 10_800_000
    && typeof segment.endMs === "number" && Number.isFinite(segment.endMs) && segment.endMs >= segment.startMs && segment.endMs <= 10_800_000
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
    current.supabase.from("lecture_sessions").select(SESSION_COLUMNS).eq("id", sessionId).maybeSingle(),
    fetchAllSegments(current.supabase, sessionId, 50_000),
    current.supabase.from("lecture_questions").select("id,question,answer,question_at_ms,provider,model,external_sources,lecture_sources,material_sources,created_at").eq("session_id", sessionId).order("created_at"),
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

  let body: { action?: unknown; classroomId?: unknown; sessionId?: unknown; title?: unknown; segment?: unknown; latencyMs?: unknown; inputSource?: unknown; startRequestId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: current.isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  if (body.action === "start" || body.action === "draft") {
    const classroomId = validId(body.classroomId) ? body.classroomId : null;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 80) return NextResponse.json({ error: current.isEnglish ? "Check the lecture title." : "수업 제목을 확인해 주세요." }, { status: 400 });
    // Missing = an older client = microphone. Anything else that isn't a known
    // source is a 400, never silently coerced. A draft has no source yet; it is
    // fixed when the draft turns into a start, and pause/resume never re-read it
    // from the client.
    if (body.inputSource !== undefined && !INPUT_SOURCES.includes(body.inputSource as InputSource)) {
      return NextResponse.json({ error: current.isEnglish ? "Check the lecture input." : "강의 입력 방식을 확인해 주세요." }, { status: 400 });
    }
    const inputSource: InputSource = (body.inputSource as InputSource | undefined) ?? "microphone";
    if (body.startRequestId !== undefined && !validId(body.startRequestId)) {
      return NextResponse.json({ error: current.isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
    }
    const startRequestId = body.action === "start" && validId(body.startRequestId) ? body.startRequestId : null;
    if (body.classroomId !== null && body.classroomId !== undefined && body.classroomId !== "" && !classroomId) {
      return NextResponse.json({ error: current.isEnglish ? "Check the classroom." : "강의실을 확인해 주세요." }, { status: 400 });
    }
    if (classroomId) {
      const { data: classroom } = await current.supabase.from("classrooms").select("id").eq("id", classroomId).maybeSingle();
      if (!classroom) return NextResponse.json({ error: current.isEnglish ? "Classroom not found." : "강의실을 찾지 못했습니다." }, { status: 404 });
    }

    const draftId = body.action === "start" && validId(body.sessionId) ? body.sessionId : null;
    const now = new Date().toISOString();
    // The billing clock columns are no longer writable by the authenticated
    // role (20260902000000), so starting a draft goes through the service key
    // — scoped to the caller's own row by user_id, since it bypasses RLS.
    const admin = draftId ? createAdminClient() : null;
    if (draftId && !admin) {
      console.error("Lecture start has no admin client");
      return NextResponse.json({ error: current.isEnglish ? "Lectures are not configured yet." : "수업 기록이 아직 설정되지 않았습니다." }, { status: 503 });
    }
    // A start whose response was lost: the client retries with the same
    // startRequestId, and the row it created the first time is returned as-is
    // instead of a second billed session. Drafts are re-used by id, so the
    // draft path is already idempotent (`eq status=draft` makes a replay a no-op
    // update that falls through to the lookup below).
    if (startRequestId) {
      const { data: existing } = await current.supabase.from("lecture_sessions").select(SESSION_COLUMNS)
        .eq("user_id", current.userId).eq("start_request_id", startRequestId).maybeSingle();
      if (existing) return NextResponse.json({ session: existing }, { status: 201 });
    }
    const query = draftId && admin
      ? admin.from("lecture_sessions").update({ status: "recording", started_at: now, recording_started_at: now, recorded_ms: 0, input_source: inputSource, start_request_id: startRequestId }).eq("id", draftId).eq("user_id", current.userId).eq("status", "draft")
      : current.supabase.from("lecture_sessions").insert({
          classroom_id: classroomId,
          user_id: current.userId,
          title,
          status: body.action === "draft" ? "draft" : "recording",
          recording_started_at: body.action === "draft" ? null : now,
          input_source: inputSource,
          start_request_id: startRequestId,
        });
    const { data, error } = await query.select(SESSION_COLUMNS).single();
    if (error) {
      // 23505 = the unique (user_id, start_request_id) index: a retry raced the
      // original insert. Hand back the row that won.
      if (startRequestId && error.code === "23505") {
        const { data: raced } = await current.supabase.from("lecture_sessions").select(SESSION_COLUMNS)
          .eq("user_id", current.userId).eq("start_request_id", startRequestId).maybeSingle();
        if (raced) return NextResponse.json({ session: raced }, { status: 201 });
      }
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

  // Opening history never mutates a live connection. Recovery checks the
  // relay/ticket under the same account lock as relay open and heartbeat.
  if (body.action === "recover" && validId(body.sessionId)) {
    const admin = createAdminClient();
    if (!admin) return NextResponse.json({ error: current.isEnglish ? "Could not check this recording. Try again." : "녹음 상태를 확인하지 못했습니다. 다시 시도해 주세요." }, { status: 503 });
    const { data, error } = await admin.rpc("recover_lecture_session_service", { p_session_id: body.sessionId, p_user_id: current.userId });
    if (error || !data || data.error) return NextResponse.json({ error: current.isEnglish ? "Could not recover this lecture. Try again." : "수업을 복구하지 못했습니다. 다시 시도해 주세요." }, { status: data?.error === "SESSION_NOT_FOUND" ? 404 : 503 });
    return NextResponse.json(data);
  }

  if (body.action === "reconcile") {
    const admin = createAdminClient();
    if (!admin) return NextResponse.json({ error: current.isEnglish ? "Could not check earlier lectures." : "지난 수업을 확인하지 못했습니다." }, { status: 503 });
    const abandonedBefore = new Date(Date.now() - MAX_LECTURE_MS).toISOString();
    const { data: stale, error } = await current.supabase.from("lecture_sessions")
      .select("id").in("status", ["recording", "paused"])
      .or(`recording_started_at.lt.${abandonedBefore},and(recording_started_at.is.null,started_at.lt.${abandonedBefore})`).limit(20);
    if (error) return NextResponse.json({ error: current.isEnglish ? "Could not check earlier lectures." : "지난 수업을 확인하지 못했습니다." }, { status: 503 });
    let reconciled = 0;
    for (const session of stale ?? []) {
      const { data: saved, error: saveError } = await admin.rpc("save_lecture_final_service", {
        p_session_id: session.id, p_user_id: current.userId, p_segments: [], p_complete: true,
      });
      if (!saveError && saved?.completed) reconciled++;
    }
    // Durable pending jobs have no recency cut-off. A seven-day provider outage
    // or partially existing chunks must not make a lecture permanently vanish.
    const { data: pending, error: queueError } = await admin.from("lecture_index_queue")
      .select("session_id").eq("user_id", current.userId).eq("state", "pending").order("updated_at").limit(20);
    if (queueError) return NextResponse.json({ error: current.isEnglish ? "Could not check search preparation. Try again." : "검색 준비 상태를 확인하지 못했습니다. 다시 시도해 주세요." }, { status: 503 });
    const pendingIds = (pending ?? []).map((job) => job.session_id as string);
    scheduleLectureIndex(admin, current.userId, pendingIds);
    return NextResponse.json({ reconciled, indexed: 0, indexingDeferred: pendingIds.length, hasMore: (stale?.length ?? 0) === 20 });
  }

  if ((body.action === "pause" || body.action === "resume") && validId(body.sessionId)) {
    const functionName = body.action === "pause" ? "pause_lecture_session" : "resume_lecture_session";
    const { data, error } = await current.supabase.rpc(functionName, { p_session_id: body.sessionId });
    const state = Array.isArray(data) ? data[0] : data;
    if (error || !state) {
      if (error) console.error(`Lecture ${body.action} failed`, error.code);
      return NextResponse.json({
        error: current.isEnglish
          ? `Could not ${body.action} the lecture.`
          : body.action === "pause" ? "강의를 일시정지하지 못했습니다." : "강의를 이어서 시작하지 못했습니다.",
      }, { status: 409 });
    }
    return NextResponse.json({ status: state.status, recordedMs: Number(state.recorded_ms ?? 0) });
  }

  if (body.action === "segment" && validId(body.sessionId) && validSegment(body.segment)) {
    const segment = body.segment;
    const segmentAdmin = createAdminClient();
    if (!segmentAdmin) return NextResponse.json({ error: current.isEnglish ? "Could not save the transcript." : "스크립트를 저장하지 못했습니다." }, { status: 503 });
    const [{ data: relay, error: relayError }, { data: session }] = await Promise.all([
      segmentAdmin.from("stt_relay_sessions").select("processed_bytes,authorized_bytes").eq("session_id", body.sessionId).eq("user_id", current.userId).maybeSingle(),
      current.supabase.from("lecture_sessions").select("classroom_id,status").eq("id", body.sessionId).maybeSingle(),
    ]);
    if (relayError) return NextResponse.json({ error: current.isEnglish ? "Could not save the transcript." : "스크립트를 저장하지 못했습니다." }, { status: 503 });
    // The relay already billed PCM bytes. Saving its delayed final transcript
    // must not charge wall time again or reject the last prepaid minute at 0.
    const { data: creditData, error: creditError } = relay
      ? { data: [{ allowed: ["recording", "paused"].includes(session?.status) && (Number(relay.processed_bytes) > 0 || Number(relay.authorized_bytes) > 0), remaining_credits: 0 }], error: null }
      : await current.supabase.rpc("consume_lecture_credits_elapsed", { p_session_id: body.sessionId });
    if (!session) return NextResponse.json({ error: current.isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });
    if (creditError) {
      console.error("Credit consumption failed", creditError.code);
      // 409는 클라이언트가 강의 종료 사유로 읽는다. 세션이 정말 닫힌 경우에만
      // 그 의미가 맞고, DB 순간 장애는 재시도 카운터가 다루는 500이어야 한다.
      if (String(creditError.message ?? "").includes("LECTURE_NOT_RECORDING")) {
        return NextResponse.json({ error: current.isEnglish ? "This lecture is no longer recording." : "이 수업은 이미 종료되었습니다." }, { status: 409 });
      }
      return NextResponse.json({ error: current.isEnglish ? "Could not use credits for this lecture." : "이 수업의 크레딧을 차감하지 못했습니다." }, { status: 500 });
    }
    const credit = Array.isArray(creditData) ? creditData[0] : creditData;
    if (!credit?.allowed) {
      return NextResponse.json({
        error: current.isEnglish ? "You are out of credits. Choose a plan to continue." : "남은 크레딧이 없습니다. 요금제를 선택해 주세요.",
        credits: Number(credit?.remaining_credits ?? 0),
      }, { status: 402 });
    }
    // Parent ownership is checked above; transcript writes remain service-only.
    const { error } = await segmentAdmin.from("transcript_segments").upsert({
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

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: current.isEnglish ? "Could not delete this lecture." : "이 수업을 삭제하지 못했습니다." }, { status: 503 });
  // Database cascade triggers enqueue audio/PDF paths before removing metadata.
  const { data: deleted, error } = await admin.from("lecture_sessions").delete()
    .eq("id", sessionId).eq("user_id", current.userId).select("id").maybeSingle();
  if (error) {
    console.error("Lecture delete failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not delete this lecture." : "이 수업을 삭제하지 못했습니다." }, { status: 500 });
  }
  if (!deleted) {
    return NextResponse.json({ error: current.isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });
  }
  await drainStorageDeletions(admin, { userId: current.userId }).catch(() => console.error("Session cleanup deferred"));
  return NextResponse.json({ deleted: true });
}

export async function PATCH(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  let body: { action?: unknown; sessionId?: unknown; classroomId?: unknown; title?: unknown; durationMs?: unknown; segments?: unknown };
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 4_000_000) return NextResponse.json({ code: "FINAL_REQUEST_TOO_LARGE", error: current.isEnglish ? "Save the transcript in smaller batches." : "스크립트를 더 작은 묶음으로 저장해 주세요." }, { status: 413 });
    body = JSON.parse(raw) as typeof body;
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

  if (!validId(body.sessionId) || typeof body.durationMs !== "number" || !Number.isFinite(body.durationMs)
    || !Array.isArray(body.segments) || !body.segments.every(validSegment)
    || new Set(body.segments.map((segment) => segment.id)).size !== body.segments.length) {
    return NextResponse.json({ error: current.isEnglish ? "Invalid lecture completion data." : "수업 종료 정보를 확인해 주세요." }, { status: 400 });
  }
  // Reject the entire request, never silently acknowledge a truncated tail.
  if (body.segments.length > (body.action === "save-final" ? 250 : 50_000)) return NextResponse.json({ code: "FINAL_BATCH_TOO_LARGE", error: current.isEnglish ? "Save the transcript in smaller batches." : "스크립트를 더 작은 묶음으로 저장해 주세요." }, { status: 413 });
  if (body.action !== undefined && body.action !== "save-final") return NextResponse.json({ error: current.isEnglish ? "Invalid lecture request." : "수업 요청을 확인해 주세요." }, { status: 400 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: current.isEnglish ? "Could not finish saving the lecture. Please retry." : "강의 기록을 저장하지 못했습니다. 다시 시도해 주세요." }, { status: 503 });
  // Existing tabs still send a whole finish snapshot. Preserve that protocol
  // within the HTTP size ceiling by acknowledging bounded DB batches before
  // completing, with no provider work dispatched between them.
  let result: {
    data: { saved?: boolean; completed?: boolean; error?: string; acknowledgedSegmentIds?: string[]; [key: string]: unknown } | null;
    error: { code?: string } | null;
  } | undefined;
  if (body.action !== "save-final" && body.segments.length > 250) {
    for (let from = 0; from < body.segments.length; from += 250) {
      const batch = body.segments.slice(from, from + 250);
      result = await admin.rpc("save_lecture_final_service", {
        p_session_id: body.sessionId, p_user_id: current.userId, p_segments: batch, p_complete: false,
      });
      if (result.error || result.data?.saved !== true) break;
      const acknowledged = new Set(result.data.acknowledgedSegmentIds ?? []);
      if (batch.some((segment) => !acknowledged.has(segment.id))) {
        result = { data: null, error: { code: "INCOMPLETE_ACK" } };
        break;
      }
    }
    if (!result?.error && result?.data?.saved === true) {
      result = await admin.rpc("save_lecture_final_service", {
        p_session_id: body.sessionId, p_user_id: current.userId, p_segments: [], p_complete: true,
      });
      if (result.data?.saved === true) result.data.acknowledgedSegmentIds = body.segments.map((segment) => segment.id);
    }
  } else {
    result = await admin.rpc("save_lecture_final_service", {
      p_session_id: body.sessionId, p_user_id: current.userId,
      p_segments: body.segments, p_complete: body.action !== "save-final",
    });
  }
  const { data, error } = result!;
  if (error || !data || data.error || data.saved !== true) {
    if (error) console.error("Final transcript save failed", error.code);
    const code = data?.error;
    const message = code === "RECORDING_ALREADY_ACTIVE"
      ? current.isEnglish ? "The recording connection is still active. Wait for it to close, or pause or end recording in the other tab or device." : "녹음 연결이 아직 활성 상태입니다. 연결 종료를 기다리거나 다른 탭·기기에서 녹음을 일시정지 또는 종료해 주세요."
      : code === "RECOVERY_OUTSIDE_PAID_RECORDING"
        ? current.isEnglish ? "These segments are outside this lecture's paid recording interval. The local recovery copy has been kept." : "이 구간은 수업의 결제된 녹음 시간에 포함되지 않습니다. 기기의 복구 사본을 보관했습니다."
        : code === "SEGMENT_CONFLICT"
          ? current.isEnglish ? "A saved segment differs from this recovery copy. The local copy has been kept." : "저장된 구간과 복구 사본의 내용이 다릅니다. 기기의 복구 사본을 보관했습니다."
          : current.isEnglish ? "Could not finish saving the lecture. Please retry." : "강의 기록을 저장하지 못했습니다. 다시 시도해 주세요.";
    return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status: code === "SESSION_NOT_FOUND" ? 404 : code ? 409 : 503 });
  }
  if (data.completed && body.action !== "save-final") scheduleLectureIndex(admin, current.userId, [body.sessionId]);
  return NextResponse.json({ ...data, indexed: false });
}
