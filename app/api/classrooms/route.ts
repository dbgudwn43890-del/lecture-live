import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { createAdminClient } from "../../lib/supabase/admin";

export const runtime = "nodejs";

async function context(request: Request) {
  const userId = await getAuthenticatedUserId();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!userId) {
    return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  }
  const admin = createAdminClient();
  if (!admin) {
    return { response: NextResponse.json({ error: isEnglish ? "Classroom storage is not configured." : "강의실 저장 기능이 설정되지 않았습니다." }, { status: 503 }) };
  }
  return { userId, admin, isEnglish };
}

export async function GET(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  const [{ data: classrooms, error: classroomError }, { data: sessions, error: sessionError }, { data: questions, error: questionError }] = await Promise.all([
    current.admin.from("classrooms").select("id,title,locale,created_at,updated_at").eq("user_id", current.userId).order("updated_at", { ascending: false }),
    current.admin.from("lecture_sessions").select("id,classroom_id,title,status,started_at,ended_at,duration_seconds").eq("user_id", current.userId).order("started_at", { ascending: false }),
    current.admin.from("lecture_questions").select("session_id").eq("user_id", current.userId),
  ]);

  if (classroomError || sessionError || questionError) {
    console.error("Classroom read failed", classroomError?.code ?? sessionError?.code ?? questionError?.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not load classrooms." : "강의실을 불러오지 못했습니다." }, { status: 500 });
  }

  const questionCounts = new Map<string, number>();
  for (const question of questions ?? []) {
    questionCounts.set(question.session_id, (questionCounts.get(question.session_id) ?? 0) + 1);
  }

  return NextResponse.json({
    classrooms: (classrooms ?? []).map((classroom) => ({
      ...classroom,
      sessions: (sessions ?? [])
        .filter((session) => session.classroom_id === classroom.id)
        .map((session) => ({ ...session, question_count: questionCounts.get(session.id) ?? 0 })),
    })),
  });
}

export async function POST(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  let body: { title?: unknown; locale?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const locale = body.locale === "en" ? "en" : "ko";
  if (!title || title.length > 80) {
    return NextResponse.json({ error: current.isEnglish ? "Enter a classroom name up to 80 characters." : "강의실 이름을 1~80자로 입력해 주세요." }, { status: 400 });
  }

  const { data, error } = await current.admin.from("classrooms").insert({ user_id: current.userId, title, locale }).select("id,title,locale,created_at,updated_at").single();
  if (error) {
    console.error("Classroom create failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not create the classroom." : "강의실을 만들지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ classroom: { ...data, sessions: [] } }, { status: 201 });
}
