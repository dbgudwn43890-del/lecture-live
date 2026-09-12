import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "next/dist/build/swc/index.js";
import { validateLectureNote } from "../lib/lecture-note-context.ts";

// Use the project's installed JSX compiler to exercise the real note renderer.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (specifier.startsWith(".")) {
        for (const extension of [".ts", ".tsx", ".js"]) {
          try { return nextResolve(`${specifier}${extension}`, context); } catch {}
        }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (url.endsWith(".tsx")) return {
      format: "module", shortCircuit: true,
      source: transformSync(readFileSync(new URL(url), "utf8"), {
        filename: new URL(url).pathname,
        jsc: { parser: { syntax: "typescript", tsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
        module: { type: "es6" },
      }).code,
    };
    return nextLoad(url, context);
  },
});
const { NoteArticle } = await import("./lecture-note.tsx");

test("the saved note renders the original chart, practice conditions, and folded 70-point answer with conversation provenance", () => {
  const answer = '```lecue-chart\n{"type":"bar","title":"집단별 점수","unit":"점","series":["점수"],"rows":[{"label":"20명","values":[80]},{"label":"10명","values":[50]}]}\n```\n\n### 확인 질문\n20명은 80점, 10명은 50점. 전체 평균은?\n\n### 정답\n70점. (20 × 80 + 10 × 50) ÷ 30 = 70.';
  const question = "다른 숫자로 연습문제와 그래프를 줘";
  const note = validateLectureNote({ title: "가중평균", summary: "집단별 인원으로 가중치를 정한다.", keyPoints: [], concepts: [], sections: [{ heading: "평균 연습", blocks: [
    { type: "qa", label: "새 예제와 그래프로 가중평균 구하기", questionIds: ["Q1"], sourceIds: [], text: "다른 예제가 없어 원래 강의의 75점 예제를 씁니다." },
  ] }] }, {
    sources: new Map(), questions: new Set([question]), documents: [],
    questionSources: new Map([[question, { id: "Q1", label: "내 질문" }]]),
    answers: new Map([["Q1", [{ id: "saved-answer", questionId: "Q1", text: answer }]]]),
  });
  const html = renderToStaticMarkup(createElement(NoteArticle, { note, isEnglish: false }));
  assert.match(html, /AI 답변 원문/);
  assert.match(html, /20명은 80점, 10명은 50점/);
  assert.match(html, /aria-label="20명: 점수 80 점"/);
  assert.match(html, /aria-label="10명: 점수 50 점"/);
  assert.match(html, /<details><summary>정답 보기/);
  assert.match(html, /70점/);
  assert.doesNotMatch(html, /75점|lecue-chart/);
  assert.match(html, /새 예제와 그래프로 가중평균 구하기/);
  assert.match(html, /다른 숫자로 연습문제와 그래프를 줘/);
});
