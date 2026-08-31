import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLectureContext,
  completedWindows,
  pickWindows,
  segmentsInWindow,
  SUMMARY_WINDOW_MS,
  windowIndexOf,
} from "./lecture-summary.ts";

const line = (startMs: number, text: string) => ({ startMs, endMs: startMs + 4_000, text });

test("only windows that have finished are queued for summarising", () => {
  // 25분 진행: 0번과 1번 창은 끝났고 2번은 진행 중이다.
  assert.deepEqual(completedWindows(25 * 60_000, []), [0, 1]);
  assert.deepEqual(completedWindows(25 * 60_000, [0]), [1]);
  assert.deepEqual(completedWindows(5 * 60_000, []), []);
});

test("a segment belongs to exactly one window", () => {
  const segments = [line(0, "가"), line(SUMMARY_WINDOW_MS - 1, "나"), line(SUMMARY_WINDOW_MS, "다")];
  assert.deepEqual(segmentsInWindow(segments, 0).map((row) => row.text), ["가", "나"]);
  assert.deepEqual(segmentsInWindow(segments, 1).map((row) => row.text), ["다"]);
  assert.equal(windowIndexOf(SUMMARY_WINDOW_MS), 1);
});

test("the window whose summary shares the question's words wins", () => {
  const summaries = [
    { windowIndex: 0, startMs: 0, endMs: SUMMARY_WINDOW_MS, text: "TOPICS: 수요 곡선" },
    { windowIndex: 1, startMs: SUMMARY_WINDOW_MS, endMs: 2 * SUMMARY_WINDOW_MS, text: "TOPICS: 증권회사, 발행시장" },
  ];
  assert.deepEqual(pickWindows("증권회사가 뭐야?", summaries), [1]);
  assert.deepEqual(pickWindows("아무 관련 없는 말", summaries), []);
});

test("summarised windows are replaced, the live tail stays verbatim", () => {
  const segments = [
    line(0, "첫 구간에서 한 말"),
    line(SUMMARY_WINDOW_MS + 1_000, "둘째 구간에서 한 말"),
    line(2 * SUMMARY_WINDOW_MS + 1_000, "지금 하고 있는 말"),
  ];
  const summaries = [
    { windowIndex: 0, startMs: 0, endMs: SUMMARY_WINDOW_MS, text: "TOPICS: 첫 구간 주제" },
    { windowIndex: 1, startMs: SUMMARY_WINDOW_MS, endMs: 2 * SUMMARY_WINDOW_MS, text: "TOPICS: 둘째 구간 주제" },
  ];
  const built = buildLectureContext(segments, summaries, "지금 무슨 얘기야?");

  assert.ok(built.text.includes("첫 구간 주제"), "요약된 창은 요약으로 들어가야 한다");
  assert.ok(!built.text.includes("첫 구간에서 한 말"), "요약된 창의 원문은 빠져야 한다");
  assert.ok(built.text.includes("지금 하고 있는 말"), "진행 중인 창은 원문이어야 한다");
  assert.deepEqual(built.verbatimWindows, [2]);
});

test("a question about an earlier window pulls that window back verbatim", () => {
  const segments = [line(0, "증권회사는 기업과 투자자를 잇는다"), line(SUMMARY_WINDOW_MS + 1_000, "지금 하는 말")];
  const summaries = [{ windowIndex: 0, startMs: 0, endMs: SUMMARY_WINDOW_MS, text: "TERMS: 증권회사" }];
  const built = buildLectureContext(segments, summaries, "증권회사 정의 다시");

  assert.ok(built.text.includes("증권회사는 기업과 투자자를 잇는다"), "질문이 가리킨 구간은 원문으로 펼쳐야 한다");
  assert.deepEqual(built.verbatimWindows, [0, 1]);
});

test("with no summaries the transcript is sent exactly as before", () => {
  const segments = [line(0, "가"), line(1_000, "나")];
  const built = buildLectureContext(segments, [], "질문");
  assert.equal(built.text, "[0:00] 가\n[0:01] 나");
  assert.deepEqual(built.verbatimWindows, []);
});
