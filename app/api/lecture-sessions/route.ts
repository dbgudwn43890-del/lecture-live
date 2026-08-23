import { NextResponse } from "next/server";
import OpenAI from "openai";

import { getAuthenticatedUserId } from "../../lib/auth";
import { chunkTranscript, type TranscriptPart } from "../../lib/chunk-transcript";
import { createAdminClient } from "../../lib/supabase/admin";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

type SegmentBody = TranscriptPart & { id?: unknown };

async function context(request: Request) {
  const userId = await getAuthenticatedUserId();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!userId) return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  const admin = createAdminClient();
  if (!admin) return { response: NextResponse.json({ error: isEnglish ? "Lecture storage is not configured." : "수업 저장 기능이 설정되지 않았습니다." }, { status: 503 }) };
  return { userId, admin, isEnglish };
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
  if (!validId(sessionId)) return NextResponse.json({ error: "수업 ID를 확인해 주세요." }, { status: 400 });

  const [{ data: session, error: sessionError }, { data: segments, error: segmentError }, { data: questions, error: questionError }] = await Promise.all([
    current.admin.from("lecture_sessions").select("id,classroom_id,title,status,started_at,ended_at,duration_seconds").eq("id", sessionId).eq("user_id", current.userId).maybeSingle(),
    current.admin.from("transcript_segments").select("client_id,start_ms,end_ms,text").eq("session_id", sessionId).eq("user_id", current.userId).order("start_ms"),
    current.admin.from("lecture_questions").select("id,question,answer,provider,model,external_sources,lecture_sources,created_at").eq("session_id", sessionId).eq("user_id", current.userId).order("created_at"),
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
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  if (body.action === "start") {
    const classroomId = body.classroomId;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!validId(classroomId) || !title || title.length > 80) return NextResponse.json({ error: current.isEnglish ? "Check the classroom and lecture title." : "강의실과 수업 제목을 확인해 주세요." }, { status: 400 });
    const { data: classroom } = await current.admin.from("classrooms").select("id").eq("id", classroomId).eq("user_id", current.userId).maybeSingle();
    if (!classroom) return NextResponse.json({ error: current.isEnglish ? "Classroom not found." : "강의실을 찾지 못했습니다." }, { status: 404 });

    const { data, error } = await current.admin.from("lecture_sessions").insert({ classroom_id: classroomId, user_id: current.userId, title }).select("id,classroom_id,title,status,started_at,ended_at,duration_seconds").single();
    if (error) {
      console.error("Lecture start save failed", error.code);
      return NextResponse.json({ error: current.isEnglish ? "Could not create the lecture record." : "수업 기록을 만들지 못했습니다." }, { status: 500 });
    }
    await current.admin.from("classrooms").update({ updated_at: new Date().toISOString() }).eq("id", classroomId).eq("user_id", current.userId);
    return NextResponse.json({ session: data }, { status: 201 });
  }

  if (body.action === "segment" && validId(body.sessionId) && validSegment(body.segment)) {
    const segment = body.segment;
    const { data: session } = await current.admin.from("lecture_sessions").select("classroom_id").eq("id", body.sessionId).eq("user_id", current.userId).maybeSingle();
    if (!session) return NextResponse.json({ error: "수업을 찾지 못했습니다." }, { status: 404 });
    const { error } = await current.admin.from("transcript_segments").upsert({
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
      return NextResponse.json({ error: "스크립트를 저장하지 못했습니다." }, { status: 500 });
    }
    return NextResponse.json({ saved: true });
  }

  return NextResponse.json({ error: current.isEnglish ? "Invalid lecture request." : "수업 요청을 확인해 주세요." }, { status: 400 });
}

export async function PATCH(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  let body: { sessionId?: unknown; durationMs?: unknown; segments?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }
  if (!validId(body.sessionId) || typeof body.durationMs !== "number" || !Array.isArray(body.segments)) {
    return NextResponse.json({ error: current.isEnglish ? "Invalid lecture completion data." : "수업 종료 정보를 확인해 주세요." }, { status: 400 });
  }
  const segments = body.segments.filter(validSegment).slice(0, 5_000);
  const { data: session } = await current.admin.from("lecture_sessions").select("id,classroom_id").eq("id", body.sessionId).eq("user_id", current.userId).maybeSingle();
  if (!session) return NextResponse.json({ error: current.isEnglish ? "Lecture not found." : "수업을 찾지 못했습니다." }, { status: 404 });

  if (segments.length) {
    const { error } = await current.admin.from("transcript_segments").upsert(segments.map((segment) => ({
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

  const durationSeconds = Math.min(10_800, Math.max(0, Math.ceil(body.durationMs / 1_000)));
  if (durationSeconds > 0) {
    const supabase = await createClient();
    const { error: creditError } = await supabase.rpc("consume_lecture_credits", {
      p_session_id: body.sessionId,
      p_minute_index: Math.min(179, Math.max(0, Math.ceil(durationSeconds / 60) - 1)),
    });
    if (creditError) console.error("Final credit reconciliation failed", creditError.code);
  }
  const { error: updateError } = await current.admin.from("lecture_sessions").update({ status: "completed", ended_at: new Date().toISOString(), duration_seconds: durationSeconds }).eq("id", body.sessionId).eq("user_id", current.userId);
  if (updateError) {
    console.error("Lecture completion failed", updateError.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not finish saving the lecture." : "수업 저장을 마치지 못했습니다." }, { status: 500 });
  }

  let indexed = false;
  const chunks = chunkTranscript(segments);
  if (chunks.length && process.env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const embeddings = await openai.embeddings.create({ model: "text-embedding-3-small", input: chunks.map((chunk) => chunk.text) });
      await current.admin.from("lecture_chunks").delete().eq("session_id", body.sessionId).eq("user_id", current.userId);
      const { error } = await current.admin.from("lecture_chunks").insert(chunks.map((chunk, index) => ({
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
