import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "next/dist/build/swc/index.js";
import type { LectureNote, NoteBlock } from "../lib/lecture-note.ts";

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

const answer = '```lecue-chart\n{"type":"bar","title":"집단별 점수","unit":"점","series":["점수"],"rows":[{"label":"20명","values":[80]},{"label":"10명","values":[50]}]}\n```\n\n### 확인 질문\n20명은 80점, 10명은 50점. 전체 평균은?\n\n### 정답\n70점. (20 × 80 + 10 × 50) ÷ 30 = 70.';
const question = "다른 숫자로 연습문제와 그래프를 줘";

function savedNote(text: string): LectureNote {
  const block: NoteBlock = {
    type: "qa", label: "새 예제와 그래프로 가중평균 구하기", questionIds: ["Q1"], sourceIds: [],
    text, items: [], latex: "", mermaid: "", page: 0,
    sources: [{ id: "Q1", label: "내 질문" }],
    originalQuestions: [{ id: "Q1", text: question }],
    originalAnswers: [{ id: "saved-answer", questionId: "Q1", text: answer }],
  };
  return { title: "가중평균", summary: "집단별 인원으로 가중치를 정한다.", keyPoints: [], concepts: [], sections: [{ heading: "평균 연습", blocks: [block] }] };
}

test("a legacy note keeps its original chart and practice available inside a closed AI answer disclosure", () => {
  const note = savedNote("");
  const html = renderToStaticMarkup(createElement(NoteArticle, { note, isEnglish: false }));
  assert.match(html, /<details class="note-original-answers" data-legacy="true"><summary>AI 답변 원문 보기/);
  const beforeOriginals = html.slice(0, html.indexOf('<details class="note-original-answers"'));
  assert.doesNotMatch(beforeOriginals, /20명은 80점|70점|이전 AI 답변을 정리한 내용/);
  assert.match(html, /20명은 80점, 10명은 50점/);
  assert.match(html, /aria-label="20명: 점수 80 점"/);
  assert.match(html, /aria-label="10명: 점수 50 점"/);
  assert.match(html, /<details><summary>정답 보기/);
  assert.match(html, /70점/);
  assert.doesNotMatch(html, /75점|lecue-chart/);
  assert.match(html, /새 예제와 그래프로 가중평균 구하기/);
  assert.match(html, /다른 숫자로 연습문제와 그래프를 줘/);
});

test("a condensed answer is visible while every grouped original question and answer remains folded", () => {
  const summary = "집단별 인원을 가중치로 삼아 전체 평균을 구한다.";
  const note = savedNote(summary);
  const block = note.sections[0].blocks[0];
  block.questionIds!.push("Q2");
  block.originalQuestions!.push({ id: "Q2", text: "아니 그러니까 인원수를 왜 곱하는 거야?" });
  block.originalAnswers!.push({ id: "saved-answer-2", questionId: "Q2", text: "두 번째 대화에 저장된 설명을 그대로 보존합니다." });
  const html = renderToStaticMarkup(createElement(NoteArticle, { note, isEnglish: false }));
  const disclosure = html.indexOf('<details class="note-original-answers">');
  assert.ok(disclosure > 0, "answer history defaults to collapsed");
  const visible = html.slice(0, disclosure);
  assert.match(visible, /이전 AI 답변을 정리한 내용/);
  assert.ok(visible.includes(summary));
  assert.doesNotMatch(visible, /두 번째 대화|아니 그러니까/);
  assert.match(visible, /class="note-study-artifacts"/);
  assert.match(visible, /20명은 80점, 10명은 50점/);
  assert.match(visible, /aria-label="20명: 점수 80 점"/);
  assert.match(visible, /70점/);
  assert.match(html.slice(disclosure), /20명은 80점, 10명은 50점/);
  assert.match(html.slice(disclosure), /두 번째 대화에 저장된 설명을 그대로 보존합니다/);
  assert.match(html, /<details class="note-original-questions"><summary>원래 질문 · 2/);
  assert.match(html, /아니 그러니까 인원수를 왜 곱하는 거야/);
});

test("lecture-evidenced answers stay visible without an empty AI-history disclosure", () => {
  const note = savedNote("강의의 근거로 확인한 설명입니다.");
  delete note.sections[0].blocks[0].originalAnswers;
  const html = renderToStaticMarkup(createElement(NoteArticle, { note, isEnglish: true }));
  assert.match(html, /강의의 근거로 확인한 설명입니다/);
  assert.doesNotMatch(html, /note-original-answers|Summary of saved AI answers/);
  assert.match(html, /<details class="note-original-questions"><summary>Original questions/);
});

function block(type: NoteBlock["type"], fields: Partial<NoteBlock> = {}): NoteBlock {
  return { type, text: "", label: "", items: [], latex: "", mermaid: "", page: 0, ...fields };
}

test("structured prose keeps literal shell punctuation, line breaks, and escaped HTML in every block", () => {
  const literal = "*.md > >> < [ ] #! $(date) **plain** <script>bad()</script>";
  const note: LectureNote = {
    title: "Shell", summary: literal, keyPoints: [literal],
    sections: [{ heading: "Syntax", blocks: [
      block("paragraph", { text: `${literal}\nsecond line` }),
      block("list", { entries: [{ text: literal, children: [literal] }] }),
      block("steps", { items: [literal] }),
      block("table", { columns: [">", ">>", "["], rows: [["*.md", "# heading", "<"]], text: literal }),
      block("check", { label: literal, hint: literal, text: literal }),
      block("callout", { label: literal, text: literal }),
      block("qa", { label: literal, text: literal }),
      block("formula", { latex: "x^2", text: literal }),
      block("diagram", { mermaid: "flowchart LR\nA-->B", text: literal }),
      block("material", { text: literal }),
    ] }],
  };
  const html = renderToStaticMarkup(createElement(NoteArticle, { note, isEnglish: true }));
  assert.match(html, /\*\.md &gt; &gt;&gt; &lt; \[ \] #! \$\(date\) \*\*plain\*\* &lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;\/script&gt;\nsecond line<\/div>/);
  assert.match(html, /<th scope="col"><div class="note-text">&gt;<\/div><\/th>/);
  assert.match(html, /<th scope="col"><div class="note-text">&gt;&gt;<\/div><\/th>/);
  assert.match(html, /<td><div class="note-text">\*\.md<\/div><\/td>/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<annotation encoding="application\/x-tex">x\^2<\/annotation>/);
  assert.doesNotMatch(html, /<script>|<blockquote|<em>|class="answer-markdown"/);
  assert.equal((html.match(/&lt;script&gt;bad\(\)&lt;\/script&gt;/g) ?? []).length, 17);
});

test("code blocks preserve indentation, blank lines, redirects and HTML without Markdown or highlighting", () => {
  const code = '#!/usr/bin/env bash\n\nfor file in *.md; do\n  echo "<tag>" >> "$file"\ndone\n';
  const note: LectureNote = { title: "Script", summary: "", sections: [{ heading: "Backup", blocks: [
    block("code", { code, language: "bash", text: "Use >>, not >, for *.md." }),
  ] }] };
  const html = renderToStaticMarkup(createElement(NoteArticle, { note, isEnglish: true }));
  assert.ok(html.includes('<code data-language="bash">#!/usr/bin/env bash\n\nfor file in *.md; do\n  echo &quot;&lt;tag&gt;&quot; &gt;&gt; &quot;$file&quot;\ndone\n</code>'));
  assert.match(html, /<figcaption><div class="note-text">Use &gt;&gt;, not &gt;, for \*\.md\.<\/div><\/figcaption>/);
  assert.doesNotMatch(html, /<tag>|answer-markdown|shiki/);
});

test("each distinct saved chart and practice remains beside a summary; duplicate artifacts do not", () => {
  const note = savedNote("새 예제 두 개를 비교해 가중치를 확인한다.");
  const block = note.sections[0].blocks[0];
  block.originalAnswers!.push({ id: "copy", questionId: "Q1", text: answer });
  block.originalAnswers!.push({ id: "comparison", questionId: "Q1", text: answer.replaceAll("80", "85").replaceAll("50", "55").replaceAll("70", "75") });
  const html = renderToStaticMarkup(createElement(NoteArticle, { note, isEnglish: false }));
  const visible = html.slice(0, html.indexOf('<details class="note-original-answers">'));
  assert.equal((visible.match(/data-chart-type="bar"/g) ?? []).length, 2);
  assert.equal((visible.match(/class="answer-check"/g) ?? []).length, 2);
  assert.match(visible, /20명은 80점, 10명은 50점/);
  assert.match(visible, /20명은 85점, 10명은 55점/);
  assert.match(visible, /aria-label="20명: 점수 80 점"/);
  assert.match(visible, /aria-label="20명: 점수 85 점"/);
});

test("a whitespace-only legacy summary still keeps the only answer printable", () => {
  const note = savedNote(" \n\t");
  const html = renderToStaticMarkup(createElement(NoteArticle, { note, isEnglish: false }));
  assert.match(html, /class="note-original-answers" data-legacy="true"/);
  assert.doesNotMatch(html, /class="note-study-artifacts"/);
  assert.match(html, /20명은 80점, 10명은 50점/);
});
