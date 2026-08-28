import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeKeyterms, parseGlossary, splitTerms } from "./glossary.ts";

test("splits on commas and newlines, trims, and drops repeats", () => {
  assert.deepEqual(parseGlossary(" 증권,  채권\n증권 \n"), ["증권", "채권"]);
  assert.deepEqual(parseGlossary("Fourier, fourier"), ["Fourier"]);
  assert.deepEqual(parseGlossary(undefined), []);
});

test("caps the term count and each term's length", () => {
  const many = Array.from({ length: 80 }, (_, index) => `term${index}`).join(",");
  assert.equal(parseGlossary(many).length, 60);
  assert.equal(parseGlossary("x".repeat(90))[0].length, 40);
});

test("reads the term block the indexer appends after the pages", () => {
  const markdown = "## p.1\n첫 장\n## TERMS\n한계효용, 기회비용,한계효용\n";
  assert.deepEqual(splitTerms(markdown), ["한계효용", "기회비용"]);
  assert.deepEqual(splitTerms("## p.1\n첫 장\n"), []);
});

test("manual terms outrank the ones pulled out of the slides", () => {
  assert.deepEqual(
    mergeKeyterms(["기회비용"], ["한계효용", "기회비용"]),
    ["기회비용", "한계효용"],
  );
  // 예산이 모자라면 잘리는 쪽은 언제나 추출분이다.
  assert.deepEqual(mergeKeyterms(["가", "나"], ["다"], 2), ["가", "나"]);
});
