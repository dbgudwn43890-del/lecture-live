import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptSonioxMessages, sonioxStreamConfig } from "./soniox.ts";

test("확정 토큰들이 Deepgram 모양의 is_final Results 하나로 합쳐진다", () => {
  const [result] = adaptSonioxMessages({
    tokens: [
      { text: "트랜잭션", start_ms: 1_000, end_ms: 1_600, is_final: true },
      { text: " 격리", start_ms: 1_600, end_ms: 2_000, is_final: true },
    ],
  });
  assert.equal(result.type, "Results");
  assert.equal(result.is_final, true);
  assert.equal(result.speech_final, false);
  assert.equal(result.channel?.alternatives?.[0]?.transcript, "트랜잭션 격리");
  assert.equal(result.start, 1);
  assert.equal(result.duration, 1);
  assert.equal(result.channel?.alternatives?.[0]?.words?.[0]?.start, 1);
});

test("<end> 토큰이 speech_final을 세우고 본문에서는 빠진다", () => {
  const [result] = adaptSonioxMessages({
    tokens: [
      { text: "read uncommitted", start_ms: 0, end_ms: 900, is_final: true },
      { text: "<end>", is_final: true },
    ],
  });
  assert.equal(result.speech_final, true);
  assert.equal(result.channel?.alternatives?.[0]?.transcript, "read uncommitted");
});

test("본문 없는 <end>는 UtteranceEnd가 된다", () => {
  const [result] = adaptSonioxMessages({ tokens: [{ text: "<end>", is_final: true }] });
  assert.equal(result.type, "UtteranceEnd");
});

test("미확정 꼬리는 is_final=false 자막 메시지로 나온다", () => {
  const results = adaptSonioxMessages({
    tokens: [
      { text: "동시성", start_ms: 0, end_ms: 400, is_final: true },
      { text: " 제어", start_ms: 400, end_ms: 700, is_final: false },
    ],
  });
  assert.equal(results.length, 2);
  assert.equal(results[1].is_final, false);
  assert.equal(results[1].channel?.alternatives?.[0]?.transcript, "제어");
});

test("문장 사이에 낀 <end>가 두 문장을 가른다", () => {
  const results = adaptSonioxMessages({
    tokens: [
      { text: "끝났습니다", start_ms: 0, end_ms: 800, is_final: true },
      { text: "<end>", is_final: true },
      { text: " 다음", start_ms: 1_200, end_ms: 1_500, is_final: true },
      { text: " 주제는", start_ms: 1_500, end_ms: 1_900, is_final: true },
    ],
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].channel?.alternatives?.[0]?.transcript, "끝났습니다");
  assert.equal(results[0].speech_final, true);
  assert.equal(results[1].channel?.alternatives?.[0]?.transcript, "다음 주제는");
  assert.equal(results[1].speech_final, false);
  assert.equal(results[1].start, 1.2);
});

test("한 메시지의 <end> 두 개가 문장 두 개로 나온다", () => {
  const results = adaptSonioxMessages({
    tokens: [
      { text: "첫 문장", start_ms: 0, end_ms: 500, is_final: true },
      { text: "<end>", is_final: true },
      { text: " 둘째 문장", start_ms: 900, end_ms: 1_400, is_final: true },
      { text: "<end>", is_final: true },
    ],
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].speech_final, true);
  assert.equal(results[1].speech_final, true);
  assert.equal(results[1].channel?.alternatives?.[0]?.transcript, "둘째 문장");
});

test("빈 메시지는 아무것도 만들지 않는다", () => {
  assert.deepEqual(adaptSonioxMessages({}), []);
  assert.deepEqual(adaptSonioxMessages({ tokens: [] }), []);
});

test("config는 용어 예산을 지키고 세션 꼬리표를 단다", () => {
  const config = sonioxStreamConfig({ keyterms: ["RAG", " ", "idempotency"], sessionId: "abc" });
  assert.equal(config.model, "stt-rt-v5");
  assert.deepEqual(config.language_hints, ["ko", "en"]);
  assert.equal(config.client_reference_id, "session-abc");
  assert.deepEqual((config as { context?: { terms: string[] } }).context?.terms, ["RAG", "idempotency"]);
  const empty = sonioxStreamConfig({ keyterms: [], sessionId: "abc" });
  assert.equal((empty as { context?: unknown }).context, undefined);
});
