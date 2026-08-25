import assert from "node:assert/strict";
import test from "node:test";

import { cleanAnswerText, cleanSources } from "./answer-format.ts";

test("removes markdown decoration and inline source links", () => {
  assert.equal(
    cleanAnswerText("현재 대통령은 **이재명 대통령**입니다. ([대통령실](https://president.go.kr/video?utm_source=openai))"),
    "현재 대통령은 이재명 대통령입니다.",
  );
  assert.equal(cleanAnswerText("공식 발표입니다 (https://example.com/news)."), "공식 발표입니다.");
});

test("normalizes, diversifies, and limits sources", () => {
  const sources = cleanSources([
    { title: "공식 1", url: "https://official.example/a?utm_source=openai" },
    { title: "공식 2", url: "https://official.example/b" },
    { title: "언론", url: "https://news.example/story" },
    { title: "중복", url: "https://news.example/story" },
    { title: "제외", url: "http://unsafe.example" },
  ], 3);

  assert.deepEqual(sources, [
    { title: "공식 1", url: "https://official.example/a" },
    { title: "언론", url: "https://news.example/story" },
    { title: "공식 2", url: "https://official.example/b" },
  ]);
});
