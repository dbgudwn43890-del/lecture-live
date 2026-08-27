import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { isUuid } from "../../lib/billing";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

const KINDS = new Set(["stt_error", "context_miss"]);

// Pilot instrumentation (PRD 36.2): the learner reports a misheard transcript
// paragraph or an answer that missed the lecture context. Everything else the
// pilot measures — question frequency, time on the lecture — already falls out
// of lecture_questions and lecture_sessions.
export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!userId) return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });

  const rateLimit = await checkSharedRateLimit(`lecture-reports:${userId}`, 60, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: isEnglish ? "Too many reports. Try again shortly." : "신고 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: { sessionId?: unknown; classroomId?: unknown; kind?: unknown; targetText?: unknown; note?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid request." : "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const kind = typeof body.kind === "string" && KINDS.has(body.kind) ? body.kind : "";
  const targetText = typeof body.targetText === "string" ? body.targetText.trim().slice(0, 2_000) : "";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!isUuid(body.sessionId) || !kind || !targetText) {
    return NextResponse.json({ error: isEnglish ? "Check the report request." : "신고 내용을 확인해 주세요." }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase.from("lecture_reports").insert({
    session_id: body.sessionId,
    classroom_id: isUuid(body.classroomId) ? body.classroomId : null,
    user_id: userId,
    kind,
    target_text: targetText,
    note: note || null,
  });
  if (error) {
    console.error("Lecture report save failed", error.code);
    return NextResponse.json({ error: isEnglish ? "Could not save the report." : "신고를 저장하지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
