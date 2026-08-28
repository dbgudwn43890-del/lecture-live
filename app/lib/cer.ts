/**
 * 받아쓰기 품질을 숫자로 재는 도구 (PRD 26.2). 엄지 척/아래로는 keyterm 개수도
 * 포맷 옵션도 정할 수 없다. /stt-lab만 쓴다 — 강의 경로에서는 기준 원고가 없다.
 */
const MAX_INPUT = 20_000;

/** 띄어쓰기와 문장부호는 채점하지 않는다. 어느 글자를 들었는지만 본다. */
export function normalizeForCer(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/gu, "")
    .toLowerCase()
    .slice(0, MAX_INPUT);
}

/** 편집거리 / 기준 길이. 2행만 들고 있으면 되므로 표를 만들지 않는다. */
export function characterErrorRate(reference: string, hypothesis: string): number {
  const source = [...normalizeForCer(reference)];
  const target = [...normalizeForCer(hypothesis)];
  if (!source.length) return target.length ? 1 : 0;

  let previous = Array.from({ length: target.length + 1 }, (_unused, index) => index);
  for (let row = 1; row <= source.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= target.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (source[row - 1] === target[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[target.length] / source.length;
}

/** 용어집이 실제로 받아쓰기에 나타난 비율. keyterm이 값을 하는지 보는 지표다. */
export function termRecall(terms: string[], hypothesis: string): number {
  const found = terms.filter((term) => normalizeForCer(term) && normalizeForCer(hypothesis).includes(normalizeForCer(term)));
  return terms.length ? found.length / terms.length : 0;
}
