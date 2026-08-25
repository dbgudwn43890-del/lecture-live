import assert from "node:assert/strict";
import test from "node:test";

import { chunkTranscript, countTranscriptSentences, groupTranscriptParagraphs } from "./chunk-transcript.ts";

test("groups adjacent transcript parts without losing time boundaries", () => {
  const chunks = chunkTranscript([
    { startMs: 0, endMs: 1_000, text: "첫 문장" },
    { startMs: 1_000, endMs: 2_000, text: "둘째 문장" },
    { startMs: 2_000, endMs: 3_000, text: "긴 세 번째 문장" },
  ], 14);

  assert.deepEqual(chunks, [
    { startMs: 0, endMs: 2_000, text: "첫 문장\n둘째 문장" },
    { startMs: 2_000, endMs: 3_000, text: "긴 세 번째 문장" },
  ]);
});

test("groups short speech segments into readable paragraphs and counts sentences", () => {
  const parts = [
    { startMs: 0, endMs: 1_000, text: "첫 문장입니다." },
    { startMs: 1_000, endMs: 2_000, text: "둘째 문장입니다." },
    { startMs: 2_000, endMs: 3_000, text: "셋째 문장입니다." },
    { startMs: 3_000, endMs: 4_000, text: "마지막 발화" },
  ];

  assert.deepEqual(groupTranscriptParagraphs(parts), [
    { startMs: 0, endMs: 3_000, text: "첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다." },
    { startMs: 3_000, endMs: 4_000, text: "마지막 발화" },
  ]);
  assert.equal(countTranscriptSentences(parts), 4);
});
