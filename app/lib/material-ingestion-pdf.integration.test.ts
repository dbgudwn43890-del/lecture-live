import assert from "node:assert/strict";
import test from "node:test";
import { compressedCommentPdf, compressedPdf } from "./material-pdf-fixture.ts";
import { extractBoundedPdf } from "./material-ingestion-pdf.ts";
import { boundedMaterialChunks } from "./material-ingestion-budget.ts";


test("a tiny compressed 500,001-character PDF is rejected by the real parser", async () => {
  const bytes = compressedPdf(["a".repeat(500_001)]);
  assert.ok(bytes.length < 2_000);
  await assert.rejects(extractBoundedPdf(bytes), /MATERIAL_TEXT_LIMIT/);
  assert.ok(bytes.length > 0, "caller bytes remain available for storage");
});
test("compressed non-text expansion is rejected before allocating a 64 MiB decoded stream", async () => {
  const bytes = await compressedCommentPdf(64 * 1024 * 1024);
  assert.ok(bytes.length < 70_000);
  await assert.rejects(extractBoundedPdf(bytes), /PDF_RESOURCE_LIMIT/);
});
test("multiple individually bounded streams cannot exceed the aggregate decoded-allocation budget", async () => {
  const bytes = await compressedCommentPdf(24 * 1024 * 1024, 3);
  assert.ok(bytes.length < 80_000);
  await assert.rejects(extractBoundedPdf(bytes), /PDF_RESOURCE_LIMIT/);
});
test("real worker keeps beginning, middle and final page topics of a normal PDF", async () => {
  const topics = Array.from({ length: 24 }, (_, i) => `Page ${i + 1}: Interest and liquidity topic ${i + 1}.`);
  const bytes = compressedPdf(topics);
  const result = await extractBoundedPdf(bytes);
  assert.equal(result.pageCount, 24);
  assert.equal(result.pages.length, 24);
  const stored = boundedMaterialChunks(result.pages).chunks.map(chunk => chunk.text).join("\n");
  for (const [i, topic] of topics.entries()) {
    assert.equal(result.pages[i].text, topic);
    assert.ok(stored.includes(topic));
  }
  assert.ok(bytes.length > 0);
});
test("canceling actual workers releases capacity for the next normal PDF", async () => {
  const bytes = compressedPdf(["ordinary lecture text"]);
  const controller = new AbortController();
  const canceled = extractBoundedPdf(bytes, controller.signal);
  controller.abort();
  await assert.rejects(canceled, /PDF_ABORTED/);
  assert.equal((await extractBoundedPdf(bytes)).pages[0].text, "ordinary lecture text");
});
