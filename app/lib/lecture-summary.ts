/**
 * 구간 요약. 질문 한 번에 스크립트 전체를 프롬프트로 보내면 비용과 대기 시간이
 * 강의 길이에 비례해 늘어난다. 세 시간짜리 수업이면 50만 자다.
 *
 * 대신 10분마다 그 구간을 한 번 압축해 두고, 질문할 때는
 *   지난 구간 요약 전부 + 최근 구간 원문 + 질문과 맞는 구간 원문
 * 만 보낸다. 강의 전체를 여전히 '알고' 있으면서 보내는 양은 한 자리 수 비율로
 * 줄어든다. 요약은 사람이 읽으라고 만드는 글이 아니라 모델이 읽을 색인이므로
 * 문장을 다듬지 않는다.
 */
export const SUMMARY_WINDOW_MS = 600_000;

/** 한 수업은 3시간이 상한이므로 창은 0..17이다. 마이그레이션의 check와 같은 값. */
export const MAX_WINDOW_INDEX = 17;

/** 질문마다 원문으로 펼칠 창의 수. 최근 구간은 여기에 더해 항상 붙는다. */
export const EXPANDED_WINDOWS = 1;

export type Summary = { windowIndex: number; startMs: number; endMs: number; text: string };
export type SummarySegment = { startMs: number; endMs: number; text: string };

export function windowIndexOf(ms: number): number {
  return Math.min(MAX_WINDOW_INDEX, Math.max(0, Math.floor(ms / SUMMARY_WINDOW_MS)));
}

/**
 * 이미 끝난 창만 요약한다. 지금 말이 쌓이고 있는 창을 요약하면 몇 분 뒤 같은
 * 구간을 다시 요약해야 하고, 그때 (session_id, window_index) 유일 인덱스가
 * 먼저 쓴 반쪽짜리 요약을 지켜 준다 — 즉 영영 반쪽으로 남는다.
 */
export function completedWindows(lastEndMs: number, existing: Iterable<number>): number[] {
  const done = new Set(existing);
  const current = windowIndexOf(lastEndMs);
  const windows: number[] = [];
  for (let index = 0; index < current; index += 1) if (!done.has(index)) windows.push(index);
  return windows;
}

export function segmentsInWindow(segments: SummarySegment[], windowIndex: number): SummarySegment[] {
  const start = windowIndex * SUMMARY_WINDOW_MS;
  const end = start + SUMMARY_WINDOW_MS;
  // 시작 시각으로 가른다. 창 경계를 걸친 문장이 두 요약에 다 들어가면 같은 말을
  // 두 번 사는 셈이다.
  return segments.filter((segment) => segment.startMs >= start && segment.startMs < end);
}

export const SUMMARY_PROMPT = [
  "대학 강의 스크립트 한 구간이다. 나중에 다른 모델이 읽고 질문에 답하도록",
  "압축하라. 산문 아니라 색인이다.",
  "",
  "형식:",
  "TOPICS: 다룬 주제, 쉼표 구분.",
  "TERMS: 전문용어·고유명사·기호, 쉼표 구분. 강사가 정의한 말 반드시 포함.",
  "POINTS: 한 줄 하나, '- ' 시작. 주장·정의·인과·예시를 말한 순서대로.",
  "  정의는 정의된 말과 뜻을 한 줄에. 숫자·연도·수식은 그대로.",
  "",
  "핵심어 보존: 각 문장의 주어·목적어가 되는 전문용어는 요약에 반드시 남긴다.",
  "  '딥러닝은 머신러닝의 한 종류다' -> TERMS와 POINTS에 딥러닝·머신러닝 둘 다.",
  "받아쓰기 오류 정정: 문맥상 명백히 잘못 적힌 용어는 표준 표기로 고친다.",
  "  '머시노닝'->'머신러닝', '컨볼루션 신경마'->'컨볼루션 신경망'. 확신 없으면 그대로 둔다.",
  "  일반어 오탈자는 건드리지 않는다 — 전문용어만.",
  "",
  "지어내지 않는다. 스크립트에 없는 배경지식 덧붙이지 않는다. 인사말·잡담 버린다.",
  "1500자 넘기지 않는다.",
].join("\n");

/** 요약 하나가 컬럼 상한(4000)을 넘지 않게. 넘치면 뒤가 아니라 앞이 남아야 한다. */
export const MAX_SUMMARY_CHARACTERS = 4_000;

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 질문과 겹치는 말이 가장 많은 창을 고른다.
 *
 * ponytail: 글자 조각 겹침이다. 요약마다 임베딩을 붙이면 더 정확해지지만, 18개
 * 중 한둘을 고르는 일에는 이걸로 충분하고 API 호출이 늘지 않는다. 인용이 자꾸
 * 엉뚱한 구간에서 나오면 그때 임베딩으로 올린다.
 */
/** 질문에서 검색 조각을 만든다. 개념 카드 매칭(ask)도 같은 조각을 쓴다. */
export function buildProbes(question: string): Set<string> {
  const probes = new Set<string>();
  for (const token of question.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < 2) continue;
    probes.add(token);
    // 한국어는 조사가 붙어 온다. "증권회사가"는 "증권회사"의 부분 문자열이 아니라
    // 그 반대이므로, 토큰만으로는 자기 얘기를 하는 구간을 못 찾는다. 3자 조각이
    // 형태소 분석기 없이 그 간극을 메운다. 2자는 우연히 겹치는 일이 너무 잦다.
    for (let index = 0; index + 3 <= token.length; index += 1) probes.add(token.slice(index, index + 3));
  }
  return probes;
}

export function pickWindows(question: string, summaries: Summary[], limit = EXPANDED_WINDOWS): number[] {
  const probes = buildProbes(question);
  if (!probes.size) return [];

  const scored = summaries
    .map((summary) => {
      const haystack = summary.text.toLowerCase();
      let score = 0;
      for (const probe of probes) if (haystack.includes(probe)) score += probe.length;
      return { windowIndex: summary.windowIndex, score };
    })
    // 조각 하나도 못 맞춘 구간은 이 질문과 무관하다. 억지로 하나 끼워 넣으면
    // 아끼려던 토큰을 관계없는 원문에 쓰게 된다.
    .filter((row) => row.score >= 3)
    // 동점이면 나중 구간이 이긴다. 질문은 대체로 방금 들은 말에 대한 것이다.
    .sort((a, b) => b.score - a.score || b.windowIndex - a.windowIndex);
  return scored.slice(0, Math.max(0, limit)).map((row) => row.windowIndex);
}

/**
 * 프롬프트에 들어갈 강의 본문을 만든다. 요약이 없으면(짧은 수업, 요약 실패)
 * 지금까지처럼 원문 전체를 돌려준다 — 요약 경로가 죽어도 답변은 나와야 한다.
 */
export function buildLectureContext(
  segments: SummarySegment[],
  summaries: Summary[],
  question: string,
): { text: string; verbatimWindows: number[]; sourceCharacters: number; sentCharacters: number } {
  const verbatimLine = (segment: SummarySegment) => `[${clock(segment.startMs)}] ${segment.text}`;
  const sourceCharacters = segments.reduce((total, segment) => total + segment.text.length, 0);

  if (!summaries.length) {
    const text = segments.map(verbatimLine).join("\n");
    return { text, verbatimWindows: [], sourceCharacters, sentCharacters: text.length };
  }

  const summarised = new Set(summaries.map((summary) => summary.windowIndex));
  const lastWindow = segments.length ? windowIndexOf(segments.at(-1)!.endMs) : 0;
  // 아직 요약되지 않은 창은 전부 원문이다. 보통은 진행 중인 마지막 창 하나다.
  const verbatim = new Set<number>();
  for (let index = 0; index <= lastWindow; index += 1) if (!summarised.has(index)) verbatim.add(index);
  for (const index of pickWindows(question, summaries)) verbatim.add(index);

  const blocks: string[] = [];
  for (let index = 0; index <= lastWindow; index += 1) {
    const start = index * SUMMARY_WINDOW_MS;
    if (verbatim.has(index)) {
      const lines = segmentsInWindow(segments, index).map(verbatimLine);
      if (lines.length) blocks.push(`[${clock(start)}~ 원문]\n${lines.join("\n")}`);
      continue;
    }
    const summary = summaries.find((row) => row.windowIndex === index);
    if (summary) blocks.push(`[${clock(summary.startMs)}~${clock(summary.endMs)} 요약]\n${summary.text}`);
  }

  const text = blocks.join("\n\n");
  return { text, verbatimWindows: [...verbatim].sort((a, b) => a - b), sourceCharacters, sentCharacters: text.length };
}
