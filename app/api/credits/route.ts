import { NextResponse } from "next/server";

import { isUuid } from "../../lib/billing";
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
  return { supabase };
}

export async function GET(request: Request) {
  const context = await current(request);
  if ("response" in context) return context.response;
  const [{ data, error }, { data: grants, error: grantError }] = await Promise.all([
    context.supabase.rpc("get_credit_status"),
    context.supabase
      .from("credit_grants")
      .select("plan_code")
      .gt("remaining_credits", 0)
      .lte("starts_at", new Date().toISOString())
      .gt("expires_at", new Date().toISOString())
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (error) {
    console.error("Credit status failed", error.code);
    return NextResponse.json({ error: message(request, "크레딧 기능이 아직 설정되지 않았습니다.", "Credits are not configured yet.") }, { status: 503 });
  }
  const row = Array.isArray(data) ? data[0] : data;
  return NextResponse.json({
    credits: Number(row?.credits ?? 0),
    nextExpiry: row?.next_expiry ?? null,
    latestGrantAt: row?.latest_grant_at ?? null,
    subscriptionStatus: row?.subscription_status ?? null,
    trialUsed: Boolean(row?.trial_used),
    planCode: grantError ? null : grants?.[0]?.plan_code ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
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
