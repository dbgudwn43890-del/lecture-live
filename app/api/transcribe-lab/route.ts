import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { canUseSttLab } from "../../lib/lab-access";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { isWhisperConfigured, transcribeWithWhisper } from "../../lib/whisper";

export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 360_000;

function isWav(bytes: Uint8Array) {
  if (bytes.byteLength < 44) return false;
  return (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WAVE"
  );
}

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!canUseSttLab(userId)) {
    return NextResponse.json({ error: "찾을 수 없는 페이지입니다." }, { status: 404 });
  }

  return NextResponse.json(
    { configured: isWhisperConfigured() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId();
  if (!canUseSttLab(userId)) {
    return NextResponse.json({ error: "찾을 수 없는 페이지입니다." }, { status: 404 });
  }

  if (!isWhisperConfigured()) {
    return NextResponse.json(
      { error: "Cloudflare Workers AI 환경 변수가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  const rateLimit = await checkSharedRateLimit(`transcribe-lab:${userId}`, 18, 60_000);
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
  const result = await transcribeWithWhisper(audioBuffer, { language: "ko", prompt: prompt || undefined });
  if ("error" in result) {
    console.error("Cloudflare transcription failed", result.error);
    return NextResponse.json({ error: "한국어 음성 인식 요청에 실패했습니다." }, { status: result.status });
  }

  return NextResponse.json(
    { text: result.text, latencyMs: Date.now() - startedAt, language: result.language },
    { headers: { "Cache-Control": "no-store" } },
  );
}
