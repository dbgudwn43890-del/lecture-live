import { NextResponse } from "next/server";
import OpenAI from "openai";

import { chunkTranscript, type TranscriptPart } from "../../lib/chunk-transcript";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

/** One lecture's hard cap. Past this a "recording" row cannot still be live. */
const MAX_LECTURE_MS = 10_800_000;

type SegmentBody = TranscriptPart & { id?: unknown };

async function context(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!user) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
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

  const [{ data: session, error: sessionError }, { data: segments, error: segmentError }, { data: questions, error: questionError }] = await Promise.all([
    current.supabase.from("lecture_sessions").select("id,classroom_id,title,status,started_at,ended_at,duration_seconds").eq("id", sessionId).maybeSingle(),
    current.supabase.from("transcript_segments").select("client_id,start_ms,end_ms,text").eq("session_id", sessionId).order("start_ms"),
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

  let body: { action?: unknown; classroomId?: unknown; sessionId?: unknown; title?: unknown; segment?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: current.isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  if (body.action === "start") {
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

    const { data, error } = await current.supabase.from("lecture_sessions").insert({ classroom_id: classroomId, user_id: current.userId, title }).select("id,classroom_id,title,status,started_at,ended_at,duration_seconds").single();
    if (error) {
      console.error("Lecture start save failed", error.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not create the lecture record." : "수업 기록을 만들지 못했습니다." }, { status: 500 });
    }
    if (classroomId) await current.supabase.from("classrooms").update({ updated_at: new Date().toISOString() }).eq("id", classroomId);
    return NextResponse.json({ session: data }, { status: 201 });
  }

  // A refresh or crash mid-lecture used to leave the row in "recording"
  // forever: the library showed it as live and the workspace opened it at
  // 0:00. Only sessions past the 3-hour cap are closed — a session younger
  // than that may be recording right now in another tab, and completing it
  // would make every further audio chunk fail with LECTURE_NOT_RECORDING.
  if (body.action === "reconcile") {
    const abandonedBefore = new Date(Date.now() - MAX_LECTURE_MS).toISOString();
    const { data: stale, error } = await current.supabase
      .from("lecture_sessions")
      .select("id")
      .eq("status", "recording")
      .lt("started_at", abandonedBefore)
      .limit(20);
    if (error) {
      console.error("Stale lecture lookup failed", error.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not check earlier lectures." : "지난 수업을 확인하지 못했습니다." }, { status: 500 });
    }

    for (const session of stale ?? []) {
      const { data: last } = await current.supabase
        .from("transcript_segments")
        .select("end_ms")
        .eq("session_id", session.id)
        .order("end_ms", { ascending: false })
        .limit(1)
        .maybeSingle();
      await current.supabase
        .from("lecture_sessions")
        .update({
          status: "completed",
          ended_at: new Date().toISOString(),
          duration_seconds: Math.round((last?.end_ms ?? 0) / 1_000),
        })
        .eq("id", session.id);
    }
    return NextResponse.json({ reconciled: stale?.length ?? 0 });
  }

  if (body.action === "segment" && validId(body.sessionId) && validSegment(body.segment)) {
    const segment = body.segment;
    const { data: session } = await current.supabase.from("lecture_sessions").select("classroom_id").eq("id", body.sessionId).maybeSingle();
    if (!session) return NextResponse.json({ error: current.isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });
    const { error } = await current.supabase.from("transcript_segments").upsert({
      session_id: body.sessionId,
      classroom_id: session.classroom_id,
      user_id: current.userId,
      client_id: segment.id,
      start_ms: Math.round(segment.startMs),
      end_ms: Math.round(segment.endMs),
      text: segment.text.trim(),
    }, { onConflict: "session_id,client_id" });
    if (error) {
      console.error("Transcript segment save failed", error.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not save the transcript." : "스크립트를 저장하지 못했습니다." }, { status: 500 });
    }
    return NextResponse.json({ saved: true });
  }

  return NextResponse.json({ error: current.isEnglish ? "Invalid lecture request." : "수업 요청을 확인해 주세요." }, { status: 400 });
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
  const { data: session } = await current.supabase.from("lecture_sessions").select("id,classroom_id,started_at").eq("id", body.sessionId).maybeSingle();
  if (!session) return NextResponse.json({ error: current.isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });

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
  const durationSeconds = Math.min(10_800, Math.max(0, Math.ceil(elapsedMs / 1_000)));
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

  let indexed = false;
  const chunks = chunkTranscript(segments);
  if (chunks.length && process.env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 });
      const embeddings = await openai.embeddings.create({ model: "text-embedding-3-small", input: chunks.map((chunk) => chunk.text) });
      await current.supabase.from("lecture_chunks").delete().eq("session_id", body.sessionId);
      const { error } = await current.supabase.from("lecture_chunks").insert(chunks.map((chunk, index) => ({
        session_id: body.sessionId,
        classroom_id: session.classroom_id,
        user_id: current.userId,
        start_ms: chunk.startMs,
        end_ms: chunk.endMs,
        text: chunk.text,
        embedding: embeddings.data[index].embedding,
      })));
      if (error) throw error;
      indexed = true;
    } catch (error) {
      console.error("Lecture indexing failed", error && typeof error === "object" && "code" in error ? error.code : "unknown");
    }
  }

  return NextResponse.json({ completed: true, indexed });
}
