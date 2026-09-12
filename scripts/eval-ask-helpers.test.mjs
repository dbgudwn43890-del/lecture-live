import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokenCost, readNdjsonAnswer } from "./eval-ask-helpers.mjs";

test("waits for the final answer across split UTF-8 chunks and counts the first text once", async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode('{"delta":"핵심"}\n{"delta":" 답"}\n{"done":{"answer":"**핵심** 답","sources":[]}}');
  let firstTexts = 0;
  let allChunksRead = false;
  const response = new Response(new ReadableStream({
    async start(controller) {
      // Splitting every byte also splits Korean characters and JSON frames.
      for (const byte of bytes) {
        controller.enqueue(Uint8Array.of(byte));
        await Promise.resolve();
      }
      allChunksRead = true;
      controller.close();
    },
  }));
  const result = await readNdjsonAnswer(response, () => { firstTexts += 1; });
  assert.deepEqual(result, { answer: "**핵심** 답", sources: [] });
  assert.equal(firstTexts, 1);
  assert.equal(allChunksRead, true);
});

test("does not mistake partial output or a malformed stream for a completed answer", async () => {
  assert.deepEqual(await readNdjsonAnswer(new Response('{"delta":"partial"}\n')), { error: "no done frame" });
  assert.deepEqual(await readNdjsonAnswer(new Response('{"delta":"partial"}\n{"error":"provider failed"}\n')), { error: "provider failed" });
  assert.deepEqual(await readNdjsonAnswer(new Response('not json\n{"done":{"answer":"bad"}}\n')), { error: "invalid NDJSON frame" });
  assert.deepEqual(await readNdjsonAnswer(new Response('null\n')), { error: "invalid NDJSON frame" });
});

test("missing provider cache counters do not turn cost estimates into NaN", () => {
  assert.equal(estimateTokenCost({ inputTokens: 100, outputTokens: 50 }), 0.00008);
  assert.equal(estimateTokenCost({ inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 10, outputTokens: 50 }), 0.0000769);
  assert.equal(estimateTokenCost(null), 0);
});
