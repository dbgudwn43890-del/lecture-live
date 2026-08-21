import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  const apiKey = process.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "DEEPGRAM_API_KEY가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  // ponytail: 공개 전 인증 사용자별 rate limit을 이 경로에 추가한다.
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
