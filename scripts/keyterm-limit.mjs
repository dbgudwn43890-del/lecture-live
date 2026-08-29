/**
 * Deepgram keyterm 한도 실측 (PRD 36.3.1 / app/lib/deepgram.ts).
 *
 * 문서가 말하는 한도는 "요청당 500토큰"인데 한국어 토큰화 규칙은 공개돼 있지
 * 않다. deepgram.ts는 그래서 "한 글자 = 한 토큰"이라는 가장 보수적인 가정으로
 * 50개·400자를 쓴다. 이 스크립트는 실제 거부 지점을 이진 탐색해서 그 값을
 * 근거 있는 숫자로 바꾼다.
 *
 * 오디오는 0.2초 무음이면 된다. 재는 것은 받아쓰기가 아니라 keyterm을 붙인
 * 요청이 접수되는지 여부다.
 *
 *   DEEPGRAM_API_KEY=... node scripts/keyterm-limit.mjs
 */

const apiKey = process.env.DEEPGRAM_API_KEY;
if (!apiKey) {
  console.error("DEEPGRAM_API_KEY가 필요하다.");
  process.exit(1);
}

const LANGUAGE = process.env.KEYTERM_LAB_LANGUAGE ?? "multi";
const MAX_PROBE = Number(process.env.KEYTERM_LAB_MAX ?? 400);

/** 0.2초 16kHz 모노 무음. 헤더 44바이트 + 샘플. */
function silentWav(seconds = 0.2, sampleRate = 16_000) {
  const samples = Math.round(seconds * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

const audio = silentWav();

/** 서로 다른 용어를 원하는 글자 수로 찍어 낸다. 같은 말을 반복하면 중복 제거에 걸린다. */
function terms(count, length) {
  const syllables = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허";
  return Array.from({ length: count }, (_unused, index) => {
    let term = "";
    for (let position = 0; position < length; position += 1) {
      term += syllables[(index * length + position) % syllables.length];
    }
    // 앞자리를 인덱스로 갈라 놓지 않으면 주기가 짧아 같은 말이 다시 나온다.
    return `${index.toString(36)}${term}`.slice(0, length);
  });
}

let firstRejection = "";

async function accepts(keyterms) {
  const params = new URLSearchParams({ model: "nova-3", language: LANGUAGE, smart_format: "true" });
  for (const term of keyterms) params.append("keyterm", term);
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/wav" },
    body: audio,
  });
  if (response.ok) return true;
  const body = await response.text();
  if (!firstRejection) firstRejection = `${response.status} ${body.slice(0, 300)}`;
  // 429/5xx는 한도가 아니라 사고다. 이진 탐색이 잘못된 방향으로 수렴하지 않게 멈춘다.
  if (response.status !== 400) {
    throw new Error(`한도와 무관한 응답: ${response.status} ${body.slice(0, 200)}`);
  }
  return false;
}

/** 마지막으로 접수된 개수. 아무것도 통과하지 못하면 0. */
async function findLimit(termLength) {
  if (!(await accepts(terms(1, termLength)))) return 0;
  let low = 1;
  let high = MAX_PROBE;
  if (await accepts(terms(high, termLength))) return high; // 상한이 더 위에 있다
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (await accepts(terms(middle, termLength))) low = middle;
    else high = middle;
  }
  return low;
}

const lengths = [2, 4, 6, 10];
const rows = [];
for (const length of lengths) {
  const limit = await findLimit(length);
  rows.push({ length, limit, characters: limit * length });
  console.log(`용어 길이 ${length}자 → 최대 ${limit}개 (${limit * length}자)`);
}

const budget = Math.min(...rows.map((row) => row.characters));
const count = Math.min(...rows.map((row) => row.limit));
console.log("");
if (firstRejection) console.log(`첫 거부 응답: ${firstRejection}`);
console.log("");
console.log("app/lib/deepgram.ts에 넣을 값 (가장 빡빡한 조합에서 10% 여유):");
console.log(`  export const MAX_KEYTERMS = ${Math.max(1, Math.floor(count * 0.9))};`);
console.log(`  export const KEYTERM_CHARACTER_BUDGET = ${Math.max(1, Math.floor(budget * 0.9))};`);
