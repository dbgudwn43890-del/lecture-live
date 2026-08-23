import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { isUuid } from "../../lib/billing";
import { checkRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!userId) {
    return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });
  }

  let body: { sessionId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid lecture request." : "수업 요청을 확인해 주세요." }, { status: 400 });
  }
  if (!isUuid(body.sessionId)) {
    return NextResponse.json({ error: isEnglish ? "Invalid lecture session." : "수업 정보를 확인해 주세요." }, { status: 400 });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "DEEPGRAM_API_KEY가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  const rateLimit = checkRateLimit(`deepgram-token:${userId}`, 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "음성 인식 연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const supabase = await createClient();
  const { data: statusData, error: statusError } = await supabase.rpc("get_credit_status");
  const creditStatus = Array.isArray(statusData) ? statusData[0] : statusData;
  if (statusError) {
    console.error("Credit preflight failed", statusError.code);
    return NextResponse.json({ error: isEnglish ? "Credits are not configured yet." : "크레딧 기능이 아직 설정되지 않았습니다." }, { status: 503 });
  }
  if (Number(creditStatus?.credits ?? 0) < 1) {
    return NextResponse.json({
      error: isEnglish ? "You are out of credits. Choose a plan to start recording." : "남은 크레딧이 없습니다. 요금제를 선택해 주세요.",
    }, { status: 402 });
  }

  const response = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}` },
    cache: "no-store",
  });

  if (!response.ok) {
    console.error("Deepgram token grant failed", response.status);
    return NextResponse.json({ error: "음성 인식 연결을 준비하지 못했습니다." }, { status: 502 });
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    return NextResponse.json({ error: "음성 인식 토큰이 비어 있습니다." }, { status: 502 });
  }

  const { data: creditData, error: creditError } = await supabase.rpc("consume_lecture_credits", {
    p_session_id: body.sessionId,
    p_minute_index: 0,
  });
  if (creditError) {
    console.error("Initial credit consumption failed", creditError.code);
    return NextResponse.json({ error: isEnglish ? "Credits are not configured yet." : "크레딧 기능이 아직 설정되지 않았습니다." }, { status: 503 });
  }
  const credit = Array.isArray(creditData) ? creditData[0] : creditData;
  if (!credit?.allowed) {
    return NextResponse.json({
      error: isEnglish ? "You are out of credits. Choose a plan to start recording." : "남은 크레딧이 없습니다. 요금제를 선택해 주세요.",
    }, { status: 402 });
  }

  return NextResponse.json(
    { accessToken: data.access_token, credits: Number(credit.remaining_credits) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
