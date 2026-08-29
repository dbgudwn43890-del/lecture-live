import assert from "node:assert/strict";
import { test } from "node:test";

import { bootstrapTerms } from "./bootstrap-terms.ts";

test("반복해서 나온 말만 뽑고, 조사는 떼고 센다", () => {
  const text = "한계효용이 줄어듭니다. 한계효용은 소비량이 늘면 줄고, 한계효용의 크기를 봅니다. 오늘 오늘 오늘";
  const terms = bootstrapTerms(text);
  assert.ok(terms.includes("한계효용"));
  // 한 번만 나온 말은 그 수업의 주제어가 아니다.
  assert.ok(!terms.includes("크기"));
  // 어디서나 나오는 말은 빈도가 높아도 버린다.
  assert.ok(!terms.includes("오늘"));
});

test("영문 토막은 두 번만 나와도 챙긴다", () => {
  const terms = bootstrapTerms("EBITDA를 보면요. EBITDA 계산이 이렇습니다.");
  assert.ok(terms.includes("EBITDA"));
});

test("이미 들고 있는 용어는 다시 넣지 않는다", () => {
  const text = "한계효용 한계효용 한계효용 기회비용 기회비용 기회비용";
  assert.deepEqual(bootstrapTerms(text, ["한계효용"]), ["기회비용"]);
});

test("빈도 높은 순으로 자른다", () => {
  const text = ["가나다 ".repeat(5), "라마바 ".repeat(4), "사아자 ".repeat(3)].join(" ");
  assert.deepEqual(bootstrapTerms(text, [], 2), ["가나다", "라마바"]);
});
