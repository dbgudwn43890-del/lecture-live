import assert from "node:assert/strict";
import { test } from "node:test";

import { characterErrorRate, normalizeForCer, termRecall } from "./cer.ts";

test("scores only the characters, not the spacing or punctuation", () => {
  assert.equal(normalizeForCer("증권, 회사!"), "증권회사");
  assert.equal(characterErrorRate("증권 회사", "증권회사."), 0);
});

test("counts one deletion against the reference length", () => {
  assert.equal(characterErrorRate("가나다", "가다"), 1 / 3);
  assert.equal(characterErrorRate("가나다", "가라다"), 1 / 3);
});

test("an empty reference is perfect only against an empty hypothesis", () => {
  assert.equal(characterErrorRate("", ""), 0);
  assert.equal(characterErrorRate("", "가"), 1);
});

test("term recall ignores spacing the recognizer chose", () => {
  assert.equal(termRecall(["한계효용", "기회비용"], "한계 효용이 커진다"), 0.5);
  assert.equal(termRecall([], "무엇이든"), 0);
});
