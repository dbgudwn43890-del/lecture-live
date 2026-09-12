import assert from "node:assert/strict";
import { test } from "node:test";
import { requestedMaterialPages, indexedMaterialPageText } from "./material-pages.ts";

test("recognizes explicit Korean and English page references and ranges", () => {
  for (const question of ["7페이지는 못 보시나요?", "7쪽 설명", "p.7", "p 7", "page7", "Page 7"]) {
    assert.deepEqual(requestedMaterialPages(question), { pages: [7], limited: false }, question);
  }
  for (const question of ["7~9페이지", "7페이지부터 9페이지", "7쪽부터9쪽", "7쪽에서 9쪽까지", "pages 7–9", "pp.7-9", "page 7 to page 9"]) {
    assert.deepEqual(requestedMaterialPages(question).pages, [7, 8, 9], question);
  }
  assert.deepEqual(requestedMaterialPages("7쪽과 9쪽을 비교").pages, [7, 9]);
});

test("does not infer pages from unrelated numbers and bounds huge ranges", () => {
  assert.deepEqual(requestedMaterialPages("연 7%, 12개월, 7개 페이지, 7:12").pages, []);
  assert.deepEqual(requestedMaterialPages("0페이지").pages, []);
  assert.deepEqual(requestedMaterialPages("p7 + p8 = 15, p7x를 구해줘, homepage7").pages, []);
  assert.equal(requestedMaterialPages("pages 1-999999").pages.length, 12);
  assert.equal(requestedMaterialPages("pages 1-999999").limited, true);
});

test("selects only requested-page text and never treats an unmarked legacy span as proof", () => {
  const chunks = [
    { start_page: 1, end_page: 4, text: "irrelevant overview" },
    { start_page: 6, end_page: 8, text: "six then eight; seven was empty" },
    { start_page: 8, end_page: 12, text: "highest semantic score" },
  ];
  assert.equal(indexedMaterialPageText(chunks, 7), "");
  chunks.push({ start_page: 7, end_page: 7, text: "page seven exact" });
  assert.equal(indexedMaterialPageText(chunks, 7), "page seven exact");
  assert.equal(indexedMaterialPageText([{ start_page: 6, end_page: 8, text: "## p.6\nsix\n\n## p.7\nseven\n\n## p.8\neight" }], 7), "seven");
});
