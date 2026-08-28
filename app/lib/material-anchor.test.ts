import assert from "node:assert/strict";
import test from "node:test";

import { buildAnchor } from "./material-anchor.ts";

const long = (mark: string) => `${mark} 이 부분은 앵커 판정을 넘기기 위한 충분히 긴 강의 발화입니다.`;

test("keeps only the last minute before the question", () => {
  const anchor = buildAnchor(
    [
      { startMs: 0, endMs: 5_000, text: long("아주 오래된 슬라이드") },
      { startMs: 300_000, endMs: 305_000, text: long("지금 슬라이드") },
    ],
    306_000,
  );
  assert.ok(anchor.includes("지금 슬라이드"));
  assert.ok(!anchor.includes("아주 오래된 슬라이드"));
});

test("drops segments that come after the question time", () => {
  const anchor = buildAnchor(
    [
      { startMs: 100_000, endMs: 105_000, text: long("질문 전에 한 말") },
      { startMs: 120_000, endMs: 125_000, text: long("질문 뒤에 한 말") },
    ],
    110_000,
  );
  assert.ok(anchor.includes("질문 전에 한 말"));
  assert.ok(!anchor.includes("질문 뒤에 한 말"));
});

test("returns nothing when the window holds too little speech", () => {
  assert.equal(buildAnchor([{ startMs: 0, endMs: 1_000, text: "네" }], 2_000), "");
  assert.equal(buildAnchor([], 60_000), "");
});

test("keeps the newest speech when the window overflows", () => {
  const segments = Array.from({ length: 60 }, (_, index) => ({
    startMs: index * 1_000,
    endMs: index * 1_000 + 900,
    text: index === 0 ? "첫 문장 이것은 앵커 길이 상한을 넘기려고 채워 넣는 문장입니다." : `${index}번 문장 이것은 앵커 길이 상한을 넘기려고 채워 넣는 문장입니다.`,
  }));
  const anchor = buildAnchor(segments, 60_000);
  assert.ok(anchor.length <= 1_200);
  assert.ok(anchor.includes("59번 문장"));
  assert.ok(!anchor.includes("첫 문장"));
});

test("includes the interim line that has not been finalized yet", () => {
  const anchor = buildAnchor([], 10_000, "지금 막 말하고 있는 문장이 여기에 들어갑니다. 아직 확정되지 않은 발화도 앵커에 쓰인다.");
  assert.ok(anchor.includes("지금 막 말하고"));
});
