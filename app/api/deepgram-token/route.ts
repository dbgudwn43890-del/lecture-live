import { NextResponse } from "next/server";

import { checkRateLimit } from "../../lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const apiKey = process.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "DEEPGRAM_API_KEY가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  const rateLimit = checkRateLimit(request, "deepgram-token", 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "음성 인식 연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
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

  return NextResponse.json(
    { accessToken: data.access_token },
    { headers: { "Cache-Control": "no-store" } },
  );
}
