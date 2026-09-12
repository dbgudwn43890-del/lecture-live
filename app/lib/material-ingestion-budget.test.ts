import assert from "node:assert/strict";
import test from "node:test";
import { boundedMaterialChunks } from "./material-ingestion-budget.ts";
import { chunkPages } from "./material-text.ts";

test("rejects 500,001 characters and excessive Unicode token bounds", () => {
  assert.throws(() => boundedMaterialChunks([{ page: 1, text: "a".repeat(500_001) }]), /MATERIAL_TEXT_LIMIT/);
  assert.throws(() => boundedMaterialChunks([{ page: 1, text: "한".repeat(100_000) }]), /MATERIAL_TEXT_LIMIT/);
});
test("chunk limit rejects before reading the rest of the source pages", () => {
  const pages = [{ page: 1, text: "a".repeat(5_401) }];
  Object.defineProperty(pages, 1, { get() { throw new Error("read beyond budget"); } });
  assert.throws(() => chunkPages(pages, 1_800, 3), /MATERIAL_CHUNK_LIMIT/);
});
test("page markers count towards aggregate embedding input", () => {
  const pages = Array.from({ length: 500 }, (_, i) => ({ page: i + 1, text: "a".repeat(500) }));
  assert.throws(() => boundedMaterialChunks(pages), /MATERIAL_TEXT_LIMIT/);
});
test("ordinary multilingual lecture material is preserved exactly", () => {
  const pages = [{ page: 1, text: "한글 𝑥² 日本語 😀" }, { page: 2, text: "Interest = principal × rate" }];
  const result = boundedMaterialChunks(pages);
  for (const page of pages) assert.ok(result.chunks[0].text.includes(page.text));
  assert.equal(result.tokenBound, Buffer.byteLength(result.chunks[0].text, "utf8"));
});
