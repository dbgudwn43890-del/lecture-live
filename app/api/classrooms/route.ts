import { NextResponse } from "next/server";

import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

async function context(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!user) {
    return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  }
  return { userId: user.id, supabase, isEnglish };
}

export async function GET(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  const [{ data: classrooms, error: classroomError }, { data: sessions, error: sessionError }, { data: questions, error: questionError }] = await Promise.all([
    current.supabase.from("classrooms").select("id,title,locale,created_at,updated_at").order("updated_at", { ascending: false }),
    current.supabase.from("lecture_sessions").select("id,classroom_id,title,status,started_at,ended_at,duration_seconds").order("started_at", { ascending: false }),
    current.supabase.from("lecture_questions").select("session_id"),
  ]);

  if (classroomError || sessionError || questionError) {
    console.error("Classroom read failed", classroomError?.code ?? sessionError?.code ?? questionError?.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not load classrooms." : "강의실을 불러오지 못했습니다." }, { status: 500 });
  }

  const questionCounts = new Map<string, number>();
  for (const question of questions ?? []) {
    questionCounts.set(question.session_id, (questionCounts.get(question.session_id) ?? 0) + 1);
  }

  const withQuestionCounts = (sessions ?? []).map((session) => ({
    ...session,
    question_count: questionCounts.get(session.id) ?? 0,
  }));

  return NextResponse.json({
    classrooms: (classrooms ?? []).map((classroom) => ({
      ...classroom,
      sessions: withQuestionCounts.filter((session) => session.classroom_id === classroom.id),
    })),
    unassignedSessions: withQuestionCounts.filter((session) => session.classroom_id === null),
  });
}

export async function POST(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  let body: { title?: unknown; locale?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: current.isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const locale = body.locale === "en" ? "en" : "ko";
  if (!title || title.length > 80) {
    return NextResponse.json({ error: current.isEnglish ? "Enter a classroom name up to 80 characters." : "강의실 이름을 1~80자로 입력해 주세요." }, { status: 400 });
  }

  const { data, error } = await current.supabase.from("classrooms").insert({ user_id: current.userId, title, locale }).select("id,title,locale,created_at,updated_at").single();
  if (error) {
    console.error("Classroom create failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not create the classroom." : "강의실을 만들지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ classroom: { ...data, sessions: [] } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  let body: { classroomId?: unknown; title?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: current.isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const classroomId = typeof body.classroomId === "string" ? body.classroomId : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(classroomId) || !title || title.length > 80) {
    return NextResponse.json({ error: current.isEnglish ? "Check the classroom name." : "강의실 이름을 확인해 주세요." }, { status: 400 });
  }

  const { data, error } = await current.supabase
    .from("classrooms")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", classroomId)
    .select("id,title,locale,created_at,updated_at")
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("Classroom rename failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not rename the classroom." : "강의실 이름을 바꾸지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ classroom: data });
}
