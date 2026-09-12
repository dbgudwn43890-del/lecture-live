import assert from "node:assert/strict";
import { test } from "node:test";

import { chunkPages, normalizeMaterialText, splitPages } from "./material-text.ts";

test("storage normalization removes NUL and repairs only unpaired surrogates", () => {
  const visible = "한글 English 日本語\n𝑥² + α = ½\t한\u0301 Ａ 😀";
  assert.equal(normalizeMaterialText(visible), visible, "visible Unicode, combining marks and whitespace stay unchanged");
  assert.equal(normalizeMaterialText(`\u0000${visible}\u0000\ud800끝\udc00`), `${visible}\ufffd끝\ufffd`);
  assert.equal(normalizeMaterialText("\ud835\udc65"), "𝑥", "a valid mathematical surrogate pair stays intact");
});

test("chunks repair malformed extracted text before storage and preserve page boundaries", () => {
  const chunks = chunkPages([
    { page: 1, text: "한글\u0000 English 𝑥² + α = ½\n다음 줄\ud800" },
    { page: 2, text: "\u0000" },
    { page: 3, text: "日本語 😀 \udc00" },
  ]);
  assert.deepEqual(chunks, [
    { startPage: 1, endPage: 1, text: "한글 English 𝑥² + α = ½\n다음 줄\ufffd" },
    { startPage: 3, endPage: 3, text: "日本語 😀 \ufffd" },
  ]);
  assert.ok(chunks.every(chunk => chunk.text.isWellFormed() && !chunk.text.includes("\u0000")));
});

test("the default 1800-unit boundary never splits a valid mathematical character", () => {
  const text = `${"a".repeat(1_799)}𝑥² + 한글 English`;
  const chunks = chunkPages([{ page: 7, text }]);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text.length, 1_799);
  assert.ok(chunks[1].text.startsWith("𝑥²"));
  assert.ok(chunks.every(chunk => chunk.text.isWellFormed() && chunk.text.length <= 1_800));
  assert.ok(chunks.every(chunk => chunk.startPage === 7 && chunk.endPage === 7));
  assert.equal(chunks.map(chunk => chunk.text).join(""), text);
});

test("tiny chunk budgets retain every complete Unicode character and terminate", () => {
  const text = "𝑥😀한A𝑦";
  for (const maxCharacters of [1, 2, 3, 4]) {
    const chunks = chunkPages([{ page: 4, text }], maxCharacters);
    assert.equal(chunks.map(chunk => chunk.text).join(""), text);
    assert.ok(chunks.every(chunk => chunk.text.isWellFormed() && chunk.text.length <= Math.max(2, maxCharacters)));
    assert.ok(chunks.every(chunk => chunk.startPage === 4 && chunk.endPage === 4));
  }
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => chunkPages([{ page: 1, text }], invalid), RangeError);
  }
});

test("keeps page numbers and drops the preamble before the first header", () => {
  const pages = splitPages("여기 있습니다\n## p.1\n첫 장\n## p. 2\n둘째 장\n");
  assert.deepEqual(pages, [{ page: 1, text: "첫 장" }, { page: 2, text: "둘째 장" }]);
});

test("sorts out-of-order pages and skips empty ones", () => {
  assert.deepEqual(splitPages("## p.3\n셋\n## p.2\n\n## p.1\n하나"), [
    { page: 1, text: "하나" },
    { page: 3, text: "셋" },
  ]);
});

test("packs short pages together and splits one that is too long", () => {
  const packed = chunkPages([{ page: 1, text: "가".repeat(30) }, { page: 2, text: "나".repeat(30) }], 100);
  assert.deepEqual(packed, [{ startPage: 1, endPage: 2, text: `## p.1\n${"가".repeat(30)}\n\n## p.2\n${"나".repeat(30)}` }]);

  const split = chunkPages([{ page: 4, text: "다".repeat(250) }], 100);
  assert.equal(split.length, 3);
  assert.deepEqual(split.map((chunk) => chunk.startPage), [4, 4, 4]);
  assert.equal(split.map((chunk) => chunk.text).join(""), "다".repeat(250));
});

test("does not turn a skipped empty page into an apparent page range", () => {
  assert.deepEqual(chunkPages([{ page: 6, text: "six" }, { page: 7, text: "" }, { page: 8, text: "eight" }]), [
    { startPage: 6, endPage: 6, text: "six" },
    { startPage: 8, endPage: 8, text: "eight" },
  ]);
});

test("stops collecting when a section that is not a page begins", () => {
  const pages = splitPages("## p.1\n첫 장\n## TERMS\n한계효용, 기회비용\n");
  assert.deepEqual(pages, [{ page: 1, text: "첫 장" }]);
});

test("keeps readable output when the model omits page markers", () => {
  assert.deepEqual(splitPages("스택은 후입선출 구조입니다.\n\n## TERMS\n스택, 큐"), [
    { page: 1, text: "스택은 후입선출 구조입니다." },
  ]);
});

test("native text preserves Korean, tables and literal model-style headings without AI rewriting", async () => {
  const { readTextMaterial, MAX_NATIVE_TEXT_CHARACTERS } = await import("./material-text.ts");
  const original = '## TERMS\r\n용어,정의\r\n"RAG, 검색",검색 증강 생성';
  const expected = original.replaceAll('\r\n', '\n');
  assert.deepEqual(readTextMaterial(new TextEncoder().encode(original)), [{ page: 1, text: expected }]);
  assert.deepEqual(readTextMaterial(Buffer.from('\ufeff한국어\tEnglish', 'utf16le')), [{ page: 1, text: '한국어\tEnglish' }]);
  assert.deepEqual(readTextMaterial(new TextEncoder().encode('  \n  ')), []);
  assert.throws(() => readTextMaterial(Uint8Array.from([0xc3, 0x28])));
  assert.throws(() => readTextMaterial(new TextEncoder().encode('abc\u0000def')), /INVALID_TEXT/);
  assert.throws(() => readTextMaterial(new TextEncoder().encode('가'.repeat(MAX_NATIVE_TEXT_CHARACTERS + 1))), /TEXT_TOO_LARGE/);
});
