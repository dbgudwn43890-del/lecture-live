import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { checkRateLimit } from "../../lib/rate-limit";

export const runtime = "nodejs";

const MODEL = "@cf/openai/whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 360_000;

type CloudflareResult = {
  text?: unknown;
  transcription_info?: { language?: unknown };
};

type CloudflareResponse = {
  success?: boolean;
  result?: CloudflareResult;
};

function isWav(bytes: Uint8Array) {
  if (bytes.byteLength < 44) return false;
  return (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WAVE"
  );
}

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  return NextResponse.json(
    {
      configured: Boolean(
        process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN,
      ),
      model: MODEL,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    return NextResponse.json(
      { error: "Cloudflare Workers AI 환경 변수가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  const rateLimit = checkRateLimit(`transcribe-lab:${userId}`, 18, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "음성 인식 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "올바른 음성 요청이 아닙니다." }, { status: 400 });
  }

  const audio = formData.get("audio");
  const promptValue = formData.get("prompt");
  const prompt = typeof promptValue === "string" ? promptValue.trim().slice(-500) : "";
  if (!(audio instanceof File) || audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "10초 이하의 WAV 음성만 보낼 수 있습니다." }, { status: 400 });
  }

  const audioBuffer = await audio.arrayBuffer();
  const bytes = new Uint8Array(audioBuffer);
  if (!isWav(bytes)) {
    return NextResponse.json({ error: "WAV 형식의 음성이 필요합니다." }, { status: 400 });
  }

  const startedAt = Date.now();
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 20_000);

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio: Buffer.from(audioBuffer).toString("base64"),
          task: "transcribe",
          language: "ko",
          vad_filter: true,
          condition_on_previous_text: true,
          ...(prompt ? { initial_prompt: prompt } : {}),
        }),
        cache: "no-store",
        signal: abortController.signal,
      },
    );

    if (!response.ok) {
      console.error("Cloudflare transcription failed", response.status);
      return NextResponse.json({ error: "한국어 음성 인식 요청에 실패했습니다." }, { status: 502 });
    }

    const data = await response.json() as CloudflareResponse;
    const text = typeof data.result?.text === "string" ? data.result.text.trim() : "";
    if (data.success === false || !data.result) {
      return NextResponse.json({ error: "음성 인식 결과를 받지 못했습니다." }, { status: 502 });
    }

    return NextResponse.json(
      {
        text,
        latencyMs: Date.now() - startedAt,
        language: typeof data.result.transcription_info?.language === "string"
          ? data.result.transcription_info.language
          : "ko",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json({ error: "음성 인식 응답이 20초를 넘겨 중단했습니다." }, { status: 504 });
    }
    console.error("Cloudflare transcription request failed");
    return NextResponse.json({ error: "음성 인식 서버에 연결하지 못했습니다." }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
