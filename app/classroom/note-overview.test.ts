import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    try { return nextResolve(`${specifier}.ts`, context); } catch { throw error; }
  }
} });
const { noteOverview } = await import("./note-overview.ts");
const base = { title: "변화율", summary: "", sections: [{ heading: "평균변화율", blocks: [] }, { heading: "순간변화율", blocks: [] }] };

test("a legacy summary stays available in full and topics are not mislabeled as new key facts", () => {
  const summary = "구간의 시작과 끝이 같아도 중간 속도가 일정하다는 뜻은 아닙니다. ".repeat(8);
  const result = noteOverview({ ...base, summary });
  assert.equal(result.kind, "topics");
  assert.deepEqual(result.points, ["평균변화율", "순간변화율"]);
  assert.deepEqual(result.details, [summary.trim()]);
});

test("long, multiline and extra key points are preserved rather than cut mid-condition", () => {
  const long = ("The value only stays positive if all the following conditions hold: " + "condition; ".repeat(12)).trim();
  const points = ["짧은 핵심", long, "조건\n예외", "Short point", "Third", "Fourth", "Fifth", "Sixth"];
  const result = noteOverview({ ...base, keyPoints: points });
  assert.equal(result.kind, "keyPoints");
  assert.equal(result.points.length, 5);
  assert.deepEqual(result.details, [long, "조건\n예외", "Sixth"]);
  assert.deepEqual(new Set([...result.points, ...result.details]), new Set(points));
});

test("short Korean and English points retain numbers, negation and complete sentences", () => {
  const keyPoints = ["표본이 30개 이상이어도 정규성을 보장하지 않음", "A positive value does not imply a positive derivative."];
  const result = noteOverview({ ...base, keyPoints });
  assert.deepEqual(result.points, keyPoints);
  assert.deepEqual(result.details, []);
});

test("a separate summary keeps its conditions even when short key points exist", () => {
  const summary = "단, 모든 구간에서 같은 조건이 성립해야 합니다.";
  assert.equal(noteOverview({ ...base, summary, keyPoints: ["구간 평균 계산"] }).summary, summary);
  assert.deepEqual(noteOverview({ ...base, summary, keyPoints: ["구간 평균 계산"] }).details, []);
  assert.deepEqual(noteOverview({ ...base, summary, keyPoints: [summary] }).details, []);
});
