import assert from "node:assert/strict";
import { test } from "node:test";

import { chunkPages, splitPages } from "./material-text.ts";

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
  assert.deepEqual(packed, [{ startPage: 1, endPage: 2, text: `${"가".repeat(30)}\n${"나".repeat(30)}` }]);

  const split = chunkPages([{ page: 4, text: "다".repeat(250) }], 100);
  assert.equal(split.length, 3);
  assert.deepEqual(split.map((chunk) => chunk.startPage), [4, 4, 4]);
  assert.equal(split.map((chunk) => chunk.text).join(""), "다".repeat(250));
});

test("stops collecting when a section that is not a page begins", () => {
  const pages = splitPages("## p.1\n첫 장\n## TERMS\n한계효용, 기회비용\n");
  assert.deepEqual(pages, [{ page: 1, text: "첫 장" }]);
});
