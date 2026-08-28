/** 강의실 용어집 한 줄 표기의 상한. 초과분은 조용히 잘린다. */
const MAX_TERMS = 60;
const MAX_TERM_LENGTH = 40;

/**
 * 쉼표 또는 줄바꿈으로 구분된 원문을 STT에 넘길 용어 목록으로 바꾼다.
 * 대소문자만 다른 중복은 하나로 본다(STT 힌트에 같은 말을 두 번 넣을 이유가 없다).
 */
export function parseGlossary(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const piece of raw.split(/[,\n]/)) {
    const term = piece.trim().replace(/\s+/g, " ").slice(0, MAX_TERM_LENGTH);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/**
 * 학생이 손으로 넣은 용어집과 자료에서 뽑은 용어를 하나의 keyterm 목록으로 합친다.
 * 손으로 넣은 쪽이 먼저다 — 의도가 추출보다 우선하고, 예산이 모자라면 추출분이 잘린다.
 */
export function mergeKeyterms(manual: string[], material: string[], limit = MAX_TERMS): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of [...manual, ...material]) {
    const clean = term.trim().replace(/\s+/g, " ").slice(0, MAX_TERM_LENGTH);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(clean);
    if (terms.length >= limit) break;
  }
  return terms;
}

/**
 * 색인 모델이 본문 뒤에 붙이는 `## TERMS` 목록. 강의 자료가 곧 그 과목의 어휘집이므로
 * 학생이 손으로 넣지 않아도 STT keyterm을 채울 수 있다. 블록이 없으면 빈 배열이다.
 */
export function splitTerms(markdown: string): string[] {
  const block = /^#{1,3}\s*TERMS\b[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|$)/im.exec(markdown);
  return block ? parseGlossary(block[1]) : [];
}
