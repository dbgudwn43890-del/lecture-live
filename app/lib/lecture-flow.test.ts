import assert from "node:assert/strict";
import test from "node:test";
import { buildLectureFlow, summaryFlowSection } from "./lecture-flow.ts";

const summary = { windowIndex: 0, startMs: 0, endMs: 600_000, text: "TOPICS: 스택, 큐\nTERMS: LIFO, FIFO, enqueue, dequeue\nPOINTS:\n- 스택은 마지막에 넣은 항목을 먼저 꺼낸다.\n- 큐는 먼저 넣은 항목을 먼저 꺼낸다." };

test("stored index becomes a readable section with topics, keywords and ordered points", () => {
  assert.deepEqual(summaryFlowSection(summary), {
    windowIndex: 0, startMs: 0, endMs: 600_000, title: "스택 · 큐",
    keywords: ["LIFO", "FIFO", "enqueue", "dequeue"],
    points: ["스택은 마지막에 넣은 항목을 먼저 꺼낸다.", "큐는 먼저 넣은 항목을 먼저 꺼낸다."],
  });
});

test("markdown headings, inline points and duplicates stay compact", () => {
  const result = summaryFlowSection({ ...summary, text: "**TOPICS:** Stack\n**TERMS:** push, pop, push, peek, size, empty, full\n**POINTS:** - Push inserts an item.\n- Push inserts an item.\n- Pop removes the last item.\n- " + "x".repeat(300) + "\n- Fourth point.\n- Fifth point." });
  assert.equal(result?.title, "Stack");
  assert.deepEqual(result?.keywords, ["push", "pop", "peek", "size", "empty"]);
  assert.equal(result?.points.length, 4);
  assert.equal(result?.points[0], "Push inserts an item.");
  assert.equal(result?.points[2].length, 140);
  assert.ok(result?.points[2].endsWith("…"));
});

test("legacy prose summaries can be displayed, without inventing a topic", () => {
  const result = summaryFlowSection({ ...summary, text: "A stack uses last-in, first-out ordering." }, "en");
  assert.equal(result?.title, "Key ideas");
  assert.deepEqual(result?.keywords, []);
  assert.deepEqual(result?.points, ["A stack uses last-in, first-out ordering."]);
});

test("invalid or empty summaries do not count as covered speech", () => {
  assert.equal(summaryFlowSection({ ...summary, text: "TOPICS:\nTERMS:\nPOINTS:" }), null);
  assert.equal(summaryFlowSection({ ...summary, startMs: -1 }), null);
  assert.equal(summaryFlowSection({ ...summary, endMs: 0 }), null);
  assert.equal(summaryFlowSection({ ...summary, windowIndex: 18 }), null);
  assert.deepEqual(buildLectureFlow([{ ...summary, text: "" }], 20_000), { sections: [], pending: { startMs: 0, endMs: 20_000 } });
});

test("latest speech remains a pending time range, never a raw-text fallback", () => {
  const result = buildLectureFlow([summary], 720_000);
  assert.deepEqual(result.pending, { startMs: 600_000, endMs: 720_000 });
  assert.deepEqual(buildLectureFlow([], 25_000), { sections: [], pending: { startMs: 0, endMs: 25_000 } });
  assert.deepEqual(buildLectureFlow([], 0), { sections: [], pending: null });
});

test("flow is chronological and a completed final summary leaves no pending tail", () => {
  const second = { ...summary, windowIndex: 1, startMs: 600_000, endMs: 780_000 };
  const result = buildLectureFlow([second, summary], 780_000);
  assert.deepEqual(result.sections.map(section => section.windowIndex), [0, 1]);
  assert.equal(result.pending, null);
});
