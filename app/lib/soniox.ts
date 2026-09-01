import type { DeepgramFinal } from "./deepgram";

/**
 * Soniox 실시간 경로 (한국어 수업 = 한·영 혼용 인식).
 *
 * Deepgram과 달리 파라미터가 URL이 아니라 소켓의 첫 JSON 메시지로 간다.
 * 철학은 같다 — 설정은 서버가 만들고(app/api/deepgram-token), 클라이언트는
 * 받은 것을 그대로 보낸다. 응답 토큰은 adaptSonioxMessages가 Deepgram 모양으로
 * 바꿔서, 클라이언트의 버퍼·문장 확정·앵커 로직을 한 줄도 다시 쓰지 않는다.
 */

export const SONIOX_LISTEN_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

/** Deepgram 400자보다 넉넉히. Soniox context 상한은 ~10,000자다. */
const MAX_CONTEXT_TERMS = 200;
const CONTEXT_CHARACTER_BUDGET = 4_000;

export type SonioxToken = { text: string; start_ms?: number; end_ms?: number; is_final?: boolean };
export type SonioxMessage = {
  tokens?: SonioxToken[];
  error_code?: number;
  error_message?: string;
  finished?: boolean;
};

export function sonioxStreamConfig({ keyterms, sessionId }: { keyterms: string[]; sessionId: string }) {
  const terms: string[] = [];
  let characters = 0;
  for (const term of keyterms) {
    const clean = term.trim();
    if (!clean) continue;
    if (terms.length >= MAX_CONTEXT_TERMS || characters + clean.length > CONTEXT_CHARACTER_BUDGET) break;
    terms.push(clean);
    characters += clean.length;
  }
  return {
    model: "stt-rt-v5",
    // MediaRecorder의 WebM/Opus 컨테이너를 스스로 알아낸다 (공식 웹 SDK와 동일).
    audio_format: "auto",
    // 제한이 아니라 가중치다. 한국어 문장 속 영어 용어가 라틴 문자로 남는다.
    language_hints: ["ko", "en"],
    // "<end>" 토큰이 문장 경계를 준다. Deepgram의 speech_final 역할.
    enable_endpoint_detection: true,
    // Soniox 대시보드 사용량과 lecture_credit_usage를 대조하기 위한 꼬리표.
    client_reference_id: `session-${sessionId}`,
    ...(terms.length ? { context: { terms } } : {}),
  };
}

/** "<end>"(문장 경계)와 "<fin>"(finalize 응답)은 본문이 아니다. */
function isMarker(token: SonioxToken) {
  return token.text === "<end>" || token.text === "<fin>";
}

/**
 * Soniox 응답 하나를 Deepgram Results 메시지 목록으로 바꾼다.
 * - 확정 토큰들 → is_final Results 하나 (경계 토큰이 있었으면 speech_final)
 * - 미확정 꼬리 → is_final=false Results 하나 (자막 갱신용)
 * 타임스탬프는 ms를 초로 바꿔 utteranceSegment의 기대에 맞춘다.
 */
export function adaptSonioxMessages(message: SonioxMessage): Array<DeepgramFinal & {
  type: string; is_final?: boolean; speech_final?: boolean;
}> {
  const tokens = message.tokens ?? [];
  if (!tokens.length) return [];

  const finals = tokens.filter((token) => token.is_final && !isMarker(token));
  const interims = tokens.filter((token) => !token.is_final && !isMarker(token));
  const endpointReached = tokens.some((token) => token.is_final && token.text === "<end>");
  const results: Array<DeepgramFinal & { type: string; is_final?: boolean; speech_final?: boolean }> = [];

  if (finals.length) {
    const startMs = Math.min(...finals.map((token) => token.start_ms ?? 0));
    const endMs = Math.max(...finals.map((token) => token.end_ms ?? 0));
    results.push({
      type: "Results",
      is_final: true,
      speech_final: endpointReached,
      start: startMs / 1_000,
      duration: Math.max(0, endMs - startMs) / 1_000,
      channel: {
        alternatives: [{
          // 토큰이 띄어쓰기를 포함하므로 그대로 이어 붙인다.
          transcript: finals.map((token) => token.text).join("").trim(),
          words: finals.map((token) => ({
            start: (token.start_ms ?? 0) / 1_000,
            end: (token.end_ms ?? 0) / 1_000,
            word: token.text.trim(),
          })),
        }],
      },
    });
  } else if (endpointReached) {
    // 본문 없이 경계만 온 경우 — 버퍼에 모인 문장을 닫으라는 신호다.
    results.push({ type: "UtteranceEnd" });
  }

  if (interims.length) {
    results.push({
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: interims.map((token) => token.text).join("").trim() }] },
    });
  }
  return results;
}
