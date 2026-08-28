import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { isUuid } from "../../lib/billing";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { deepgramLanguage, listenUrl } from "../../lib/deepgram";
import { mergeKeyterms, parseGlossary } from "../../lib/glossary";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!userId) {
    return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });
  }

  let body: { sessionId?: unknown; language?: unknown };
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

  // The in-process limiter this used to call is a per-instance Map, so the
  // real ceiling on a token-minting route was 10/min times however many
  // serverless instances answered. Every other paid route already shares a
  // counter in Postgres.
  const rateLimit = await checkSharedRateLimit(`deepgram-token:${userId}`, 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "음성 인식 연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const supabase = await createClient();
  // The glossary read rides along with the credit preflight: it is the same
  // round trip budget, and the socket cannot open before both come back.
  const [{ data: statusData, error: statusError }, { data: sessionRow }] = await Promise.all([
    supabase.rpc("get_credit_status"),
    supabase
      .from("lecture_sessions")
      .select("classrooms(glossary, material_documents(keyterms))")
      .eq("id", body.sessionId)
      .maybeSingle(),
  ]);
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

  // Ask for the narrowest grant Deepgram offers: the browser only ever opens a
  // listen socket, so an unscoped project token would hand it far more.
  const response = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_seconds: 30, scopes: ["listen"] }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
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

  // 자료에서 뽑은 용어가 손으로 넣은 용어집을 이어받는다. 학생이 아무것도 입력하지
  // 않아도 업로드한 슬라이드가 그 과목의 어휘집 노릇을 한다 (PRD 36.3.1).
  const classroom = (sessionRow as { classrooms?: { glossary?: string; material_documents?: Array<{ keyterms?: string }> } | null })?.classrooms;
  const keyterms = mergeKeyterms(
    parseGlossary(classroom?.glossary),
    (classroom?.material_documents ?? []).flatMap((document) => parseGlossary(document.keyterms)),
  );

  return NextResponse.json(
    {
      accessToken: data.access_token,
      credits: Number(credit.remaining_credits),
      listenUrl: listenUrl({
        language: deepgramLanguage(body.language, isEnglish ? "en" : "ko"),
        keyterms,
        sessionId: body.sessionId,
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
