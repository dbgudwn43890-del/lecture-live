/**
 * 자료를 올리지 않은 수업의 어휘를 발화 자체에서 만든다 (PRD 36.3.1의 빈칸).
 *
 * 슬라이드가 있으면 그쪽이 훨씬 정확한 용어집이다. 없는 수업은 keyterm이 빈 채로
 * 90분을 가는데, 전공어가 가장 많이 깨지는 것이 바로 그 수업들이다. 강의 앞부분에
 * 반복해서 나온 말은 그 수업의 주제어일 가능성이 높으므로, 그걸 뽑아 다음 소켓의
 * keyterm으로 넘긴다. 받아쓰기가 이미 맞힌 말을 강화하는 셈이라 새 용어를
 * 만들어내지는 못하지만, 뒤로 갈수록 흔들리는 표기를 붙잡아 준다.
 *
 * ponytail: 형태소 분석 없이 조사 접미사만 떼는 근사치다. 실측에서 잡음이 많으면
 * 최소 빈도를 올리거나 품사 분석기로 올라간다.
 */

/** 조사·어미. 떼고 남는 말이 2글자 이상일 때만 뗀다. */
const SUFFIXES = [
  "에서는", "으로는", "이라는", "라고는", "에서", "으로", "이라", "라는", "에게", "한테", "까지", "부터", "보다", "처럼", "마다",
  "은", "는", "이", "가", "을", "를", "의", "에", "도", "만", "와", "과", "로", "야",
];

/** 강의 어디서나 나오는 말. keyterm에 넣으면 예산만 먹는다. */
const STOPWORDS = new Set([
  "그리고", "그래서", "그러면", "그런데", "그러니까", "이렇게", "저렇게", "어떻게", "왜냐하면", "때문", "경우", "문제", "생각",
  "부분", "얘기", "이야기", "다음", "정도", "사람", "우리", "여러분", "선생님", "교수님", "수업", "강의", "시간", "오늘", "지금",
  "여기", "거기", "이거", "그거", "저거", "하나", "가지", "이제", "조금", "많이", "다시", "먼저", "마지막", "질문", "대답",
  "the", "and", "that", "this", "with", "from", "have", "just", "like", "what", "when", "which", "there", "here",
]);

const MIN_LENGTH = 2;
const MAX_LENGTH = 20;
/** 한 번 지나간 말은 그 수업의 주제어가 아니다. 세 번이면 되풀이다. */
const MIN_COUNT = 3;
/** 영문 토막은 한국어 강의에서 가장 잘 깨지는 자리라 문턱을 낮게 둔다. */
const MIN_COUNT_LATIN = 2;

function stripSuffix(word: string) {
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= MIN_LENGTH && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function isLatin(word: string) {
  return /[A-Za-z]{2,}/.test(word);
}

/**
 * 지금까지의 발화에서 keyterm 후보를 빈도순으로 뽑는다. 이미 들고 있는 용어와
 * 겹치는 후보는 버린다 — 예산은 새 말에 쓴다.
 */
export function bootstrapTerms(text: string, existing: string[] = [], limit = 20): string[] {
  const taken = new Set(existing.map((term) => term.trim().toLowerCase()).filter(Boolean));
  const counts = new Map<string, number>();

  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    const word = stripSuffix(raw);
    if (word.length < MIN_LENGTH || word.length > MAX_LENGTH) continue;
    if (/^\p{N}+$/u.test(word)) continue;
    const key = word.toLowerCase();
    if (STOPWORDS.has(key) || taken.has(key)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([word, count]) => count >= (isLatin(word) ? MIN_COUNT_LATIN : MIN_COUNT))
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .slice(0, limit)
    .map(([word]) => word);
}
