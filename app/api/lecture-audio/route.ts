import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { isUuid } from "../../lib/billing";
import { checkRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";
import { transcribeWithWhisper } from "../../lib/whisper";

export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 500_000;

function isWav(bytes: Uint8Array) {
  if (bytes.byteLength < 44) return false;
  return (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WAVE"
  );
}

export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!userId) return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });

  const rateLimit = checkRateLimit(`lecture-audio:${userId}`, 30, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: isEnglish ? "Too many transcription requests. Try again shortly." : "음성 인식 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid audio request." : "올바른 음성 요청이 아닙니다." }, { status: 400 });
  }

  const sessionId = formData.get("sessionId");
  const language = formData.get("language") === "en" ? "en" : "ko";
  const promptValue = formData.get("prompt");
  const prompt = typeof promptValue === "string" ? promptValue.trim().slice(-500) : "";
  const audio = formData.get("audio");

  if (!isUuid(sessionId)) return NextResponse.json({ error: isEnglish ? "Check the lecture session." : "수업 정보를 확인해 주세요." }, { status: 400 });
  if (!(audio instanceof File) || audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: isEnglish ? "The audio chunk is too large." : "음성 조각이 너무 큽니다." }, { status: 400 });
  }

  const audioBuffer = await audio.arrayBuffer();
  if (!isWav(new Uint8Array(audioBuffer))) {
    return NextResponse.json({ error: isEnglish ? "WAV audio is required." : "WAV 형식의 음성이 필요합니다." }, { status: 400 });
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
      error: isEnglish ? "You are out of credits. Choose a plan to continue." : "남은 크레딧이 없습니다. 요금제를 선택해 주세요.",
    }, { status: 402 });
  }

  const result = await transcribeWithWhisper(audioBuffer, { language, prompt: prompt || undefined });
  if ("error" in result) {
    console.error("Whisper transcription failed", result.error);
    return NextResponse.json({ error: isEnglish ? "Could not transcribe this segment." : "이 구간을 받아쓰지 못했습니다." }, { status: result.status });
  }

  return NextResponse.json({ text: result.text }, { headers: { "Cache-Control": "no-store" } });
}
