import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { listenUrl } from "../../lib/deepgram";
import { parseGlossary } from "../../lib/glossary";
import { canUseSttLab } from "../../lib/lab-access";
import { checkSharedRateLimit } from "../../lib/rate-limit";

export const runtime = "nodejs";

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!canUseSttLab(userId)) {
    return NextResponse.json({ error: "찾을 수 없는 페이지입니다." }, { status: 404 });
  }

  return NextResponse.json(
    { configured: Boolean(process.env.DEEPGRAM_API_KEY) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * 운영 강의와 같은 파라미터 집합으로 소켓을 연다. 크레딧은 차감하지 않는다 —
 * 이 화면은 운영자 도구이고, 여기서 재는 것이 강의 경로의 설정을 정한다.
 */
export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId();
  if (!canUseSttLab(userId)) {
    return NextResponse.json({ error: "찾을 수 없는 페이지입니다." }, { status: 404 });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "DEEPGRAM_API_KEY가 설정되지 않았습니다." }, { status: 503 });
  }

  const rateLimit = await checkSharedRateLimit(`transcribe-lab:${userId}`, 18, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "음성 인식 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: { keyterms?: unknown; language?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const response = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_seconds: 30, scopes: ["listen"] }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    console.error("Lab token grant failed", response.status);
    return NextResponse.json({ error: "음성 인식 연결을 준비하지 못했습니다." }, { status: 502 });
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    return NextResponse.json({ error: "음성 인식 토큰이 비어 있습니다." }, { status: 502 });
  }

  return NextResponse.json(
    {
      accessToken: data.access_token,
      listenUrl: listenUrl({
        language: body.language === "en" ? "en" : "ko",
        keyterms: parseGlossary(body.keyterms),
        sessionId: "lab",
        pcm: true,
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
