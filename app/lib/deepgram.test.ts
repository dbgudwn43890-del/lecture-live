import assert from "node:assert/strict";
import test from "node:test";

import {
  KEYTERM_CHARACTER_BUDGET,
  MAX_KEYTERMS,
  deepgramLanguage,
  keytermBudget,
  listenUrl,
  utteranceOverflowed,
  utteranceSegment,
  type DeepgramFinal,
} from "./deepgram.ts";

const final = (start: number, duration: number, transcript: string, words?: Array<[number, number]>): DeepgramFinal => ({
  start,
  duration,
  channel: {
    alternatives: [{
      transcript,
      words: words?.map(([wordStart, wordEnd]) => ({ start: wordStart, end: wordEnd, word: "x" })),
    }],
  },
});

test("joins buffered finals into one segment", () => {
  const segment = utteranceSegment([
    final(10, 1, "이 식에서"),
    final(11, 1, "분모가 커지면"),
    final(12, 1, "값은 작아집니다."),
  ]);
  assert.equal(segment?.text, "이 식에서 분모가 커지면 값은 작아집니다.");
  assert.equal(segment?.startMs, 10_000);
  assert.equal(segment?.endMs, 13_000);
});

test("prefers word timestamps over the endpointing window", () => {
  // 조각 창은 10.0~12.0이지만 실제 발화는 10.4~11.6이다. 앞뒤 침묵이 앵커 창에
  // 엉뚱한 이웃을 끌어들이지 않도록 단어 경계를 써야 한다.
  const segment = utteranceSegment([final(10, 2, "실제 발화", [[10.4, 10.9], [11.1, 11.6]])]);
  assert.equal(segment?.startMs, 10_400);
  assert.equal(segment?.endMs, 11_600);
});

test("adds the stream offset so segments after a reconnect do not restart near zero", () => {
  const segment = utteranceSegment([final(2, 1, "재연결 뒤 첫 문장")], 600_000);
  assert.equal(segment?.startMs, 602_000);
  assert.equal(segment?.endMs, 603_000);
});

test("keeps the id inside the 2200-character column and the text inside 2000", () => {
  const segment = utteranceSegment([final(0, 300, "가".repeat(5_000))]);
  assert.ok(segment);
  assert.ok(segment.id.length <= 2_200, `id was ${segment.id.length}`);
  assert.equal(segment.text.length, 2_000);
});

test("returns nothing when the buffer holds no speech", () => {
  assert.equal(utteranceSegment([]), null);
  assert.equal(utteranceSegment([final(1, 1, "   ")]), null);
});

test("flags a buffer that outgrew one sentence", () => {
  assert.equal(utteranceOverflowed([final(0, 5, "짧은 문장")]), false);
  assert.equal(utteranceOverflowed([final(0, 60, "쉬지 않고 이어지는 강의")]), true);
  assert.equal(utteranceOverflowed([final(0, 5, "가".repeat(700))]), true);
});

test("caps keyterms by count and by character budget", () => {
  const many = Array.from({ length: 80 }, (_, index) => `전문용어${index}`);
  assert.ok(keytermBudget(many).length <= MAX_KEYTERMS);

  const long = Array.from({ length: 80 }, () => "가".repeat(40));
  const kept = keytermBudget(long);
  assert.ok(kept.join("").length <= KEYTERM_CHARACTER_BUDGET);
  assert.ok(kept.length < MAX_KEYTERMS, "the character budget should bite before the count does");

  assert.deepEqual(keytermBudget([" 푸리에 변환 ", "", "  "]), ["푸리에 변환"]);
});

test("builds a listen url with repeated keyterm and no encoding", () => {
  const url = listenUrl({ language: "ko", keyterms: ["푸리에 변환", "고윳값"], sessionId: "abc" });
  assert.match(url, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.equal(url.match(/[?&]keyterm=/g)?.length, 2);
  // Nova-2 이하의 파라미터. Nova-3에서는 keyterm이다.
  assert.ok(!url.includes("keywords="));
  // 컨테이너 오디오에 encoding을 같이 주면 디코딩이 깨진다.
  assert.ok(!url.includes("encoding="));
  assert.ok(url.includes("model=nova-3"));
  assert.ok(url.includes("language=ko"));
  assert.ok(url.includes("tag=session-abc"));
});

test("accepts multilingual recognition and rejects unknown language values", () => {
  assert.equal(deepgramLanguage("multi", "ko"), "multi");
  assert.equal(deepgramLanguage("fr", "ko"), "ko");
  assert.equal(deepgramLanguage("fr", "multi"), "multi");
  const url = listenUrl({ language: "multi", keyterms: ["Lecue"], sessionId: "multi" });
  assert.ok(url.includes("language=multi"));
  assert.ok(url.includes("endpointing=100"));
});

test("describes raw PCM explicitly for the browser worklet", () => {
  const url = listenUrl({ language: "ko", keyterms: [], sessionId: "lab", pcm: true });
  assert.ok(url.includes("encoding=linear16"));
  assert.ok(url.includes("sample_rate=16000"));
  assert.ok(url.includes("channels=1"));
});
