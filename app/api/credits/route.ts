import { NextResponse } from "next/server";

import { isUuid } from "../../lib/billing";
import { getCreditStatus } from "../../lib/credit-status";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

function message(request: Request, korean: string, english: string) {
  return request.headers.get("x-site-locale") === "en" ? english : korean;
}

async function current(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { response: NextResponse.json({ error: message(request, "로그인이 필요합니다.", "Sign-in is required.") }, { status: 401 }) };
  }
  // A recording tab ticks once a minute; anything past this is a loop.
  const rateLimit = await checkSharedRateLimit(`credits:${user.id}`, 60, 60_000);
  if (!rateLimit.allowed) {
    return { response: NextResponse.json(
      { error: message(request, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", "Too many requests. Try again shortly.") },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    ) };
  }
  return { supabase };
}

export async function GET(request: Request) {
  const context = await current(request);
  if ("response" in context) return context.response;
  const status = await getCreditStatus(context.supabase);
  if ("error" in status) {
    console.error("Credit status failed", status.error);
    return NextResponse.json({ error: message(request, "크레딧 기능이 아직 설정되지 않았습니다.", "Credits are not configured yet.") }, { status: 503 });
  }
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const context = await current(request);
  if ("response" in context) return context.response;
  let body: { sessionId?: unknown; minuteIndex?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: message(request, "요청 형식이 올바르지 않습니다.", "Invalid request.") }, { status: 400 });
  }
  if (
    !isUuid(body.sessionId)
    || !Number.isInteger(body.minuteIndex)
    || Number(body.minuteIndex) < 0
    || Number(body.minuteIndex) > 179
  ) {
    return NextResponse.json({ error: message(request, "수업 사용량을 확인해 주세요.", "Check the lecture usage data.") }, { status: 400 });
  }

  const { data, error } = await context.supabase.rpc("consume_lecture_credits", {
    p_session_id: body.sessionId,
    p_minute_index: body.minuteIndex,
  });
  if (error) {
    console.error("Credit consumption failed", error.code);
    return NextResponse.json({ error: message(request, "크레딧을 차감하지 못했습니다.", "Could not use credits.") }, { status: 409 });
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.allowed) {
    return NextResponse.json({
      error: message(request, "남은 크레딧이 없습니다. 요금제를 선택해 주세요.", "You are out of credits. Choose a plan to continue."),
      credits: Number(row?.remaining_credits ?? 0),
    }, { status: 402 });
  }
  return NextResponse.json({
    credits: Number(row.remaining_credits),
    chargedThrough: Number(row.charged_through),
  }, { headers: { "Cache-Control": "no-store" } });
}
