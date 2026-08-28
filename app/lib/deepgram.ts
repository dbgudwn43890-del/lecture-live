export type DeepgramWord = { start: number; end: number; word: string; punctuated_word?: string };
export type DeepgramFinal = {
  start?: number;
  duration?: number;
  channel?: { alternatives?: Array<{ transcript?: string; words?: DeepgramWord[] }> };
};

export type ListenOptions = {
  language: "ko" | "en";
  keyterms: string[];
  sessionId: string;
  /** 컨테이너 없는 16kHz PCM을 보낼 때만. /stt-lab이 워클릿 출력을 그대로 흘린다. */
  pcm?: boolean;
};

/** transcript_segments.client_id는 2200자까지다. 본문은 2000자까지. */
const MAX_ID_TEXT = 120;
const MAX_TEXT = 2_000;

/**
 * 한 문장이 끝나기 전에 강제로 끊는 지점. 쉬지 않고 말하는 강사에게도 스크립트가
 * 쌓이게 하고, 본문이 컬럼 상한을 넘지 않게 한다. 진리가 아니라 조정 손잡이다.
 */
export const MAX_UTTERANCE_MS = 45_000;
export const MAX_UTTERANCE_CHARACTERS = 600;

/**
 * Deepgram keyterm 한도는 요청당 500토큰이다. 한국어 토큰화 규칙은 문서화되어
 * 있지 않으므로 "한 글자 = 한 토큰"이라는 가장 보수적인 가정으로 문자 예산을
 * 잡는다. 실제 거부 지점은 /stt-lab에서 이진 탐색해 이 값을 그 아래로 내린다.
 * ponytail: 측정 전 임시값. 랩 수치가 나오면 여기만 고친다.
 */
export const MAX_KEYTERMS = 50;
export const KEYTERM_CHARACTER_BUDGET = 400;

export function keytermBudget(terms: string[]): string[] {
  const kept: string[] = [];
  let characters = 0;
  for (const term of terms) {
    const clean = term.trim();
    if (!clean) continue;
    if (kept.length >= MAX_KEYTERMS) break;
    if (characters + clean.length > KEYTERM_CHARACTER_BUDGET) break;
    kept.push(clean);
    characters += clean.length;
  }
  return kept;
}

/**
 * 강의 소켓의 전체 주소. 서버에서 만든다 — 브라우저가 소켓을 들고 있으니 위조를
 * 막지는 못하지만, 용어가 오래된 클라이언트 배열이 아니라 DB에서 오고, 파라미터를
 * 클라이언트 재빌드 없이 한 파일에서 조정할 수 있다.
 */
export function listenUrl({ language, keyterms, sessionId, pcm = false }: ListenOptions): string {
  const params = new URLSearchParams({
    model: "nova-3",
    language,
    smart_format: "true",
    // punctuated_word가 이 값에 의존하므로 smart_format과 별개로 명시한다.
    punctuate: "true",
    interim_results: "true",
    // 조각을 빨리 받아 버퍼에 넣기 위해 낮춘다. 문장 경계는 endpointing이 아니라
    // speech_final과 UtteranceEnd가 정한다.
    endpointing: "300",
    utterance_end_ms: "1000",
    mip_opt_out: "true",
    // Deepgram 집계 분과 lecture_credit_usage를 대조하기 위한 꼬리표. 세그먼트를
    // 저장하지 않고 소켓만 여는 클라이언트가 있는지 여기서 드러난다.
    tag: `session-${sessionId}`,
  });
  // 컨테이너(WebM/Opus)는 Deepgram이 스스로 알아낸다. encoding을 같이 주면
  // 디코딩이 깨지므로 넣지 않는다. 반대로 raw PCM은 스스로 알아낼 헤더가 없다.
  if (pcm) {
    params.set("encoding", "linear16");
    params.set("sample_rate", "16000");
    params.set("channels", "1");
  }
  for (const term of keytermBudget(keyterms)) params.append("keyterm", term);
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

/**
 * 버퍼에 모인 is_final 결과들을 문장 하나로 합친다.
 *
 * 경계는 단어 타임스탬프에서 가져온다. result.start/duration은 조각이 확정된
 * '창'이라 endpointing만큼의 선행 침묵을 포함하고, 그 침묵이 buildAnchor의 60초
 * 창에 엉뚱한 이웃을 끌어들인다. 단어 배열이 없으면 창으로 물러난다.
 */
export function utteranceSegment(
  finals: DeepgramFinal[],
  streamOffsetMs = 0,
): { id: string; startMs: number; endMs: number; text: string } | null {
  const parts: string[] = [];
  const words: DeepgramWord[] = [];
  let windowStart = Number.POSITIVE_INFINITY;
  let windowEnd = 0;

  for (const final of finals) {
    const alternative = final.channel?.alternatives?.[0];
    const transcript = alternative?.transcript?.trim();
    if (transcript) parts.push(transcript);
    if (alternative?.words?.length) words.push(...alternative.words);
    const start = Number(final.start ?? 0);
    windowStart = Math.min(windowStart, start);
    windowEnd = Math.max(windowEnd, start + Number(final.duration ?? 0));
  }

  const text = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  if (!text) return null;

  const startSeconds = words.length ? Math.min(...words.map((word) => word.start)) : windowStart;
  const endSeconds = words.length ? Math.max(...words.map((word) => word.end)) : windowEnd;
  const startMs = Math.max(0, Math.round(startSeconds * 1_000) + streamOffsetMs);
  const endMs = Math.max(startMs, Math.round(endSeconds * 1_000) + streamOffsetMs);

  // 전체 본문을 id에 담으면 2200자 상한을 넘겨 서버가 조용히 400을 돌려준다.
  return { id: `${startMs}-${endMs}-${text.slice(0, MAX_ID_TEXT)}`, startMs, endMs, text };
}

/** 버퍼가 한 문장으로 두기에 너무 길어졌는지. speech_final을 기다리지 않고 끊는다. */
export function utteranceOverflowed(finals: DeepgramFinal[]): boolean {
  if (!finals.length) return false;
  const segment = utteranceSegment(finals);
  if (!segment) return false;
  return segment.endMs - segment.startMs >= MAX_UTTERANCE_MS || segment.text.length >= MAX_UTTERANCE_CHARACTERS;
}
