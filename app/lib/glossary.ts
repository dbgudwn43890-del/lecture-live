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
 * Whisper의 initial_prompt 앞에 붙일 힌트. 프롬프트는 500자로 잘려 서버에 오므로
 * 용어집이 직전 문장을 밀어내지 않도록 이 문자열 자체도 상한을 둔다.
 */
export function glossaryPrompt(terms: string[], maxLength = 400): string {
  if (!terms.length) return "";
  let prompt = "";
  for (const term of terms) {
    const next = prompt ? `${prompt}, ${term}` : term;
    if (next.length > maxLength) break;
    prompt = next;
  }
  return prompt ? `${prompt}.` : "";
}
