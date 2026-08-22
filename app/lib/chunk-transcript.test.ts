import assert from "node:assert/strict";
import test from "node:test";

import { chunkTranscript } from "./chunk-transcript.ts";

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
