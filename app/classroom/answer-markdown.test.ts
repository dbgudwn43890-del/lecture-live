import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import katex from "katex";
import { AnswerMarkdown } from "./answer-markdown.ts";
import { splitLearningCheck } from "../lib/learning-check.ts";
import { cleanAnswerMarkdown } from "../lib/answer-format.ts";

const render = (text: string, pending = false) => renderToStaticMarkup(createElement(AnswerMarkdown, { text, pending }));
const visibleText = (html: string) => html.replace(/<[^>]*>/g, "");

test("every streamed emphasis prefix hides Markdown stars, completed emphasis remains semantic", () => {
  for (const sample of ["**핵심**을 먼저 설명해요.", "Here **velocity** means rate of change.", "여기서 **기울기**는 변화율입니다.", "이거**핵심**이에요."]) {
    for (let i = 1; i <= sample.length; i++) assert.ok(!visibleText(render(sample.slice(0, i), true)).includes("**"), sample.slice(0, i));
    assert.match(render(cleanAnswerMarkdown(sample)), /<strong>/);
  }
});

test("a streamed comparison never flashes pipe syntax; the finished table has headers", () => {
  const sample = "차이는 측정 대상이에요.\n\n| 항목 | 의미 |\n|---|---|\n| 위치 | 어디에 있는가 |\n| 속도 | 어떻게 변하는가 |";
  for (let i = 1; i <= sample.length; i++) assert.ok(!visibleText(render(sample.slice(0, i), true)).includes("|"), sample.slice(0, i));
  assert.match(render(sample), /<table>/);
  assert.match(render(sample), /<th[ >]/);
});

test("punctuation next to Korean particles retains semantic emphasis without changing the source", () => {
  for (const [text, emphasis] of [
    ["담보유지비율은 보통 **140~150%**로 유지합니다.", "140~150%"],
    ["**연 3%**입니다.", "연 3%"],
    ["**금리(이자율)**는 바뀝니다.", "금리(이자율)"],
    ["**수익률(yield)**을 비교합니다.", "수익률(yield)"],
  ]) {
    assert.equal(cleanAnswerMarkdown(text), text);
    for (let i = 1; i <= text.length; i++) {
      assert.ok(!visibleText(render(text.slice(0, i), true)).includes("**"), text.slice(0, i));
    }
    for (const pending of [false, true]) {
      const html = render(text, pending);
      assert.ok(html.includes(`<strong>${emphasis}</strong>`), text);
      assert.equal(visibleText(html), text.replaceAll("**", ""));
    }
  }
});

test("raw HTML, remote images, unsafe URLs and math commands cannot create active content", () => {
  const html = render('**설명**\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n![track](https://tracker.example/pixel)\n\n[unsafe](javascript:alert(1))\n\n$$\\href{javascript:alert(1)}{x}$$');
  assert.doesNotMatch(html, /<(?:script|img|iframe|video|audio|input|button|form)\b|onerror=|href="javascript:/i);
  assert.match(html, /설명/);
});

test("code operators and indentation survive persistence, math renders separately from currency", () => {
  const code = '```js\n  const x = 2 ** 3;\n  const url = "https://example.com";\n  // | does not start a comparison\n```';
  assert.equal(cleanAnswerMarkdown(code), code);
  assert.match(visibleText(render(code)), /2 \*\* 3/);
  assert.match(visibleText(render(code, true)), /\| does not start/);
  assert.match(visibleText(render('```js\n  const x = 2 **', true)), /2 \*\*/);
  assert.match(render('$$x^2$$ costs $5, not $10.'), /class="katex"/);
  assert.match(visibleText(render('$$x^2$$ costs $5, not $10.')), /\$5, not \$10/);
});

test("Markdown math uses the same layout classes as the root KaTeX stylesheet and note renderer", () => {
  const formula = String.raw`\frac{3\%}{12}+\left(1+\frac{0.03}{12}\right)^{12}-1`;
  const classes = (html: string) => new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)));
  for (const displayMode of [false, true]) {
    const expected = classes(katex.renderToString(formula, { displayMode }));
    const actual = classes(render(displayMode ? `$$\n${formula}\n$$` : `월 이율은 $$${formula}$$입니다.`));
    for (const name of expected) assert.ok(actual.has(name), `Missing KaTeX layout class: ${name}`);
  }
});

test("self-check answers stay out of the streamed body and split once complete", () => {
  const text = "속도는 변화율입니다.\n\n### 확인 질문\n위치가 양수이면 속도도 양수인가요?\n\n### 정답\n아니요. 방향에 따라 달라요.";
  assert.deepEqual(splitLearningCheck(text, true), { body: "속도는 변화율입니다.", check: null });
  assert.deepEqual(splitLearningCheck(text), { body: "속도는 변화율입니다.", check: { question: "위치가 양수이면 속도도 양수인가요?", answer: "아니요. 방향에 따라 달라요." } });
  const english = splitLearningCheck("A fact.\n\n### Check yourself\nWhy?\n\n### Answer\nBecause.");
  assert.equal(english.check?.answer, "Because.");
});

test("missing self-check answer falls back to normal text; headings in code are not widgets", () => {
  const incomplete = "### 확인 질문\n질문만 있습니다.";
  assert.equal(splitLearningCheck(incomplete).body, incomplete);
  const code = "```md\n### 확인 질문\nexample\n### 정답\ncode\n```";
  assert.deepEqual(splitLearningCheck(code), { body: code, check: null });
});

test("numbered steps retain nested explanations, continuation paragraphs and later step numbers", () => {
  for (const sample of [
    "1. **조건 확인**\n\n    적용 조건을 먼저 확인합니다.\n\n    - 표본의 크기를 확인합니다.\n    - 예시: 두 집단의 크기가 다릅니다.\n\n2. **계산**\n\n    각 집단의 비중을 곱합니다.",
    "1. **Check the conditions**\n\n    Read the assumptions first.\n\n    - Check each sample size.\n    - Example: the two groups have different sizes.\n\n2. **Calculate**\n\n    Multiply by each group's weight.",
  ]) {
    assert.equal(cleanAnswerMarkdown(sample), sample);
    const html = render(sample);
    assert.match(html, /<ol[^>]*>[\s\S]*<li[^>]*>[\s\S]*<p[^>]*>[\s\S]*<ul[^>]*>[\s\S]*<\/ul>[\s\S]*<\/li>[\s\S]*<li[^>]*>/);
    assert.equal((html.match(/<ol[ >]/g) ?? []).length, 1);
    assert.equal((html.match(/<ul[ >]/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<pre[ >]/);
    assert.doesNotMatch(visibleText(html), /\*\*/);
  }
});

const composition = '```lecue-chart\n{"type":"stacked-bar","title":"방문자 구성","unit":"명","series":["PC","모바일"],"rows":[{"label":"A","values":[90,10]},{"label":"B","values":[20,80]}]}\n```';

// Synthetic fixture based only on the user-provided screenshot and prose.
const bondChart = JSON.stringify({ type: "bar", title: "금리별 5년 만기 채권 가격 비교", unit: "원", series: ["채권 가격"], rows: [
  { label: "금리 5%", values: [11229] }, { label: "금리 11%", values: [8893] },
] });

test("the screenshot bond chart renders from JSON and unlabeled fences, including saved answers", () => {
  for (const language of ["json", "JSON", "", "lecue-chart"]) {
    const source = `금리가 오르면 채권 가격은 내려갑니다.\n\n\`\`\`${language}\n${bondChart}\n\`\`\`\n\n같은 만기의 채권을 비교합니다.`;
    for (const text of [source, cleanAnswerMarkdown(source)]) {
      const html = render(text);
      assert.match(html, /<figure[^>]+data-chart-type="bar"/);
      assert.match(html, /금리별 5년 만기 채권 가격 비교/);
      assert.match(html, /11,229 원/);
      assert.match(html, /8,893 원/);
      assert.doesNotMatch(html, /<pre|&quot;rows&quot;/);
    }
  }
  const data = JSON.parse(bondChart);
  const reordered = JSON.stringify({ rows: data.rows, series: data.series, unit: data.unit, title: data.title, type: data.type });
  assert.match(render(`\`\`\`json\n${reordered}\n\`\`\``), /<figure/);
});

test("every generic chart object prefix hides raw JSON until the closing fence, in either key order", () => {
  const data = JSON.parse(bondChart);
  const reordered = JSON.stringify({ rows: data.rows, series: data.series, unit: data.unit, title: data.title, type: data.type });
  for (const language of ["json", ""]) {
    for (const chart of [bondChart, reordered]) {
      const sample = `\`\`\`${language}\n${chart}\n\`\`\``;
      for (let length = sample.indexOf("{") + 1; length < sample.length; length++) {
        const html = render(sample.slice(0, length), true);
        assert.doesNotMatch(html, /<pre|<figure|&quot;|[{}]/, `prefix ${length}`);
      }
      assert.match(render(sample, true), /<figure/);
    }
    assert.doesNotMatch(render(`\`\`\`${language}\n{"type":"bar"`, true), /<pre|answer-chart-status/);
  }
  assert.doesNotMatch(render("```json\n", true), /<pre|answer-chart-status/);
});

test("generic fallback preserves ordinary code, nested examples and complete invalid chart-shaped JSON", () => {
  const ordinary = [
    '{"type":"bar","title":"Configuration","series":[],"rows":"documentation"}',
    JSON.stringify({ example: JSON.parse(bondChart) }),
    JSON.stringify({ ...JSON.parse(bondChart), html: "<script>alert(1)</script>" }),
    '{"count":2,"rows":[1,2]}',
  ];
  for (const source of ordinary) {
    for (const pending of [false, true]) {
      const html = render(`\`\`\`json\n${source}\n\`\`\``, pending);
      assert.match(html, /<pre/);
      assert.doesNotMatch(html, /<figure|answer-chart-status|<script/);
    }
  }
  assert.doesNotMatch(render('```json\n{"count":', true), /<pre|answer-chart-status/);
  for (const language of ["js", "javascript", "typescript", "text", "md"]) {
    assert.match(render(`\`\`\`${language}\n${bondChart}\n\`\`\``), /<pre/);
    assert.doesNotMatch(render(`\`\`\`${language}\n${bondChart}\n\`\`\``), /<figure/);
  }
  assert.match(render(`Inline example: \`${bondChart}\``), /<code/);
  assert.doesNotMatch(render(`Inline example: \`${bondChart}\``), /<figure/);
});

test("every streamed chart prefix holds raw JSON until its closing fence arrives", () => {
  const sample = `**구성 비율**이 달랐어요.\n\n${composition}`;
  for (let length = 1; length < sample.length; length++) {
    const html = render(sample.slice(0, length), true);
    assert.doesNotMatch(visibleText(html), /lecue-chart|stacked-bar|"(?:title|series|rows|values)"|[{}]/, `prefix ${length}`);
    assert.doesNotMatch(html, /<figure/, `premature chart at ${length}`);
  }
  assert.match(render(sample, true), /<figure/);
  assert.match(render(`${sample}\n\n설명을 이어갑니다.`, true), /<figure[\s\S]*설명을 이어갑니다/);
});

test("saved chart Markdown retains prose, chart structure, units and exact values", () => {
  const sample = `**같은 평균이 아니에요.**\n\n${composition}\n\nA에는 PC가 더 많아요.`;
  assert.equal(cleanAnswerMarkdown(sample), sample);
  assert.equal(render(cleanAnswerMarkdown(sample)), render(sample));
  const html = render(sample);
  assert.match(html, /<strong>같은 평균이 아니에요\.<\/strong>/);
  assert.match(html, /data-chart-type="stacked-bar"/);
  assert.match(html, /90 : 10/);
  assert.match(html, /20 : 80/);
  assert.match(html, /단위: 명/);
  assert.doesNotMatch(html, /<pre/);
});

test("broken chart output uses a readable fallback and keeps surrounding Markdown", () => {
  const html = render('설명입니다.\n\n```lecue-chart\n{"rows":"<script>bad()</script>"}\n```\n\n마지막 설명입니다.');
  assert.match(html, /설명입니다/);
  assert.match(html, /그래프 형식을 읽지 못했어요/);
  assert.match(html, /마지막 설명입니다/);
  assert.doesNotMatch(html, /<script|"rows"|<pre/);
  const english = renderToStaticMarkup(createElement(AnswerMarkdown, { text: '```lecue-chart\n{\n```', isEnglish: true }));
  assert.match(english, /chart format could not be read/);
});

test("chart syntax inside another code example stays literal, while valid tilde fences render", () => {
  assert.doesNotMatch(render(`\`\`\`\`md\n${composition}\n\`\`\`\``), /<figure/);
  assert.match(visibleText(render(`\`\`\`\`md\n${composition}\n\`\`\`\``)), /lecue-chart/);
  assert.match(render(composition.replaceAll("```", "~~~")), /<figure/);
});

test("charts preserve baseline reference-Markdown behavior on both sides of the visual", () => {
  const definitions = '\n\n[ref]: https://example.com "Lecture source"';
  const before = "[강의 자료][ref]를 참고해요.";
  const after = "[다음 설명][ref]도 확인해요.";
  // This Streamdown version resolves blocks separately, so reference links
  // currently stay literal. Charts must not alter that incumbent behavior.
  const expectedBefore = visibleText(render(before + definitions));
  const expectedAfter = visibleText(render(after + definitions));
  for (const sample of [before + definitions, `${before}\n\n${composition}\n\n${after}${definitions}`]) {
    const html = render(sample);
    assert.ok(visibleText(html).includes(expectedBefore));
    if (sample.includes(composition)) assert.ok(visibleText(html).includes(expectedAfter));
    assert.doesNotMatch(visibleText(html), /https:\/\/example/);
    assert.equal(cleanAnswerMarkdown(sample), sample);
  }
});
