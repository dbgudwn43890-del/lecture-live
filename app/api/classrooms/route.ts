import { NextResponse } from "next/server";

import { isUuid } from "../../lib/billing";
import { getClassroomData } from "../../lib/classroom-data";
import { parseGlossary } from "../../lib/glossary";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

async function context(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!user) {
    return { response: NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  }
  const rateLimit = await checkSharedRateLimit(`classrooms:${user.id}`, 60, 60_000);
  if (!rateLimit.allowed) {
    return { response: NextResponse.json(
      { error: isEnglish ? "Too many requests. Try again shortly." : "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    ) };
  }
  return { user, userId: user.id, supabase, isEnglish };
}

export async function GET(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  const data = await getClassroomData(current.supabase, current.user);
  if ("error" in data) {
    console.error("Classroom read failed", data.error);
    return NextResponse.json({ error: current.isEnglish ? "Could not load classrooms." : "강의실을 불러오지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json(data);
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

  const { data, error } = await current.supabase.from("classrooms").insert({ user_id: current.userId, title, locale }).select("id,title,locale,glossary,created_at,updated_at").single();
  if (error) {
    console.error("Classroom create failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not create the classroom." : "강의실을 만들지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ classroom: { ...data, sessions: [] } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const current = await context(request);
  if ("response" in current) return current.response;

  let body: { classroomId?: unknown; title?: unknown; glossary?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: current.isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const classroomId = typeof body.classroomId === "string" ? body.classroomId : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const editsTitle = body.title !== undefined;
  const editsGlossary = body.glossary !== undefined;
  if (!isUuid(classroomId) || (editsTitle && (!title || title.length > 80))) {
    return NextResponse.json({ error: current.isEnglish ? "Check the classroom name." : "강의실 이름을 확인해 주세요." }, { status: 400 });
  }
  if (!editsTitle && !editsGlossary) {
    return NextResponse.json({ error: current.isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  // Stored normalized, so what the learner sees on the next load is exactly
  // what the transcription hint will carry — not their raw spacing.
  const glossary = editsGlossary ? parseGlossary(body.glossary).join(", ") : null;

  const { data, error } = await current.supabase
    .from("classrooms")
    .update({
      ...(editsTitle ? { title } : {}),
      ...(glossary === null ? {} : { glossary }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", classroomId)
    .select("id,title,locale,glossary,created_at,updated_at")
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("Classroom update failed", error.code);
    return NextResponse.json({ error: current.isEnglish ? "Could not save the classroom." : "강의실 정보를 저장하지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ classroom: data });
}
