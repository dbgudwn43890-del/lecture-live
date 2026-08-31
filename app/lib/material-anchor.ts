export type AnchorSegment = { startMs: number; endMs: number; text: string };

/** 자료 한 쪽을 설명하는 시간의 근사치. 짧으면 잡음, 길면 이전 내용이 섞인다. */
const WINDOW_MS = 60_000;
const MAX_CHARACTERS = 1_200;
/** 이만큼도 말하지 않은 구간은 어느 자료 내용인지 가릴 근거가 못 된다. */
const MIN_CHARACTERS = 40;

/**
 * 질문 시점 직전 1분의 강의 내용을 뽑는다. 질문 문장만으로는 "이거", "방금 그 식"
 * 같은 지시어 질문이 자료의 어느 부분을 가리키는지 알 수 없으므로, 강의가 지금 어디를
 * 지나고 있는지를 따로 담아 자료 검색에 쓴다.
 *
 * 근거가 얇으면 빈 문자열을 돌려준다. 오래된 구간까지 긁어 창을 늘리면 10분 전
 * 자료의 오래된 부분을 답변 근거로 쓰게 되는데, 그건 근거를 비우는 것보다 나쁘다.
 */
export function buildAnchor(segments: AnchorSegment[], atMs: number, interim = ""): string {
  const until = Number.isFinite(atMs) && atMs > 0 ? atMs : Number.MAX_SAFE_INTEGER;
  const since = until === Number.MAX_SAFE_INTEGER ? 0 : until - WINDOW_MS;

  const recent = segments
    .filter((segment) => segment.startMs <= until && segment.endMs >= since)
    .map((segment) => segment.text.trim())
    .filter(Boolean);
  if (interim.trim()) recent.push(interim.trim());

  const text = recent.join(" ").replace(/\s+/g, " ").trim();
  if (text.length < MIN_CHARACTERS) return "";
  // 자르려면 앞을 자른다. 최신 발화가 현재 질문에 가장 가깝다.
  return text.length > MAX_CHARACTERS ? text.slice(-MAX_CHARACTERS) : text;
}
