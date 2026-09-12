import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerChart, parseAnswerChart, type AnswerChartData } from "./answer-chart.ts";

const chart: AnswerChartData = {
  type: "stacked-bar", title: "페이지별 방문자 구성", unit: "명", series: ["PC", "모바일"],
  rows: [{ label: "A", values: [90, 10] }, { label: "B", values: [20, 80] }],
};

test("composition bars show each group's real proportions and accessible original values", () => {
  const data = parseAnswerChart(JSON.stringify({ ...chart, rows: [{ label: "A", values: [900, 100] }, chart.rows[1]] }));
  assert.ok(data);
  const html = renderToStaticMarkup(createElement(AnswerChart, { data }));
  assert.match(html, /width:90%/);
  assert.match(html, /width:10%/);
  assert.match(html, /width:20%/);
  assert.match(html, /width:80%/);
  assert.match(html, /aria-label="A: PC 900 명, 모바일 100 명"/);
  assert.match(html, /900 : 100/);
  assert.match(html, /각 그룹 안의 구성 비율/);
});

test("magnitude bars use a shared zero baseline; zero values are not given a fake minimum width", () => {
  const data = parseAnswerChart(JSON.stringify({ ...chart, type: "bar", unit: "%", series: ["구매율"], rows: [
    { label: "A", values: [80] }, { label: "B", values: [20] }, { label: "C", values: [0] },
  ] }));
  assert.ok(data);
  const html = renderToStaticMarkup(createElement(AnswerChart, { data }));
  for (const width of [100, 25, 0]) assert.match(html, new RegExp(`width:${width}%`));
  assert.match(html, /0부터 같은 눈금으로 비교/);
});

test("untrusted labels render as escaped text and cannot become HTML or network requests", () => {
  const data = parseAnswerChart(JSON.stringify({ ...chart, title: '<img src="https://tracker.invalid" onerror="alert(1)">', series: ["<script>bad()</script>", "모바일"] }));
  assert.ok(data);
  const html = renderToStaticMarkup(createElement(AnswerChart, { data }));
  assert.doesNotMatch(html, /<(?:img|script|iframe|svg)\b|\s(?:href|src|onerror)="/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test("malformed, oversized, mismatched, nonfinite, negative and executable chart data are rejected", () => {
  for (const patch of [
    null, [], { ...chart, type: "pie" }, { ...chart, title: "" }, { ...chart, title: "x".repeat(101) },
    { ...chart, title: "hidden\nheading" }, { ...chart, unit: {} }, { ...chart, unit: "x".repeat(21) },
    { ...chart, series: ["PC", " PC "] }, { ...chart, series: ["PC"] }, { ...chart, series: ["1", "2", "3", "4", "5"] },
    { ...chart, series: ["PC", { expression: "alert(1)" }] }, { ...chart, rows: [chart.rows[0]] },
    { ...chart, rows: [...chart.rows, chart.rows[0]] }, { ...chart, rows: Array.from({ length: 9 }, (_, i) => ({ label: String(i), values: [1, 2] })) },
    ...[[0, 0], [-1, 2], ["90", 10], [null, 2], [1e13, 2], [1], [1, 2, 3], [Infinity, 1]].map(values => ({ ...chart, rows: [{ label: "A", values }, chart.rows[1]] })),
    { ...chart, rows: [{ ...chart.rows[0], onClick: "alert(1)" }, chart.rows[1]] },
    { ...chart, html: "<script>" }, { ...chart, colors: ["url(https://tracker.invalid)"] },
    { ...chart, type: "bar", series: ["A"], rows: [{ label: "A", values: [0] }, { label: "B", values: [0] }] },
  ]) assert.equal(parseAnswerChart(JSON.stringify(patch)), null, JSON.stringify(patch));
  for (const source of ["{", "null", '{"__proto__":{}}', " ".repeat(8_001), JSON.stringify(chart).replace("90", "1e999")]) assert.equal(parseAnswerChart(source), null);
});

test("tiny finite values stay finite, legible and correctly scaled without rounding to zero", () => {
  const data = parseAnswerChart(JSON.stringify({ ...chart, type: "bar", series: ["비율"], rows: [{ label: "A", values: [1e-200] }, { label: "B", values: [2e-200] }] }));
  assert.ok(data);
  const html = renderToStaticMarkup(createElement(AnswerChart, { data, isEnglish: true }));
  assert.match(html, /width:50%/);
  assert.match(html, /1E-200/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("both locales preserve numeric formatting at notation boundaries and reuse formatters across renders", () => {
  const values = [0, -0, 1e-200, 0.0000999999, 0.0001, 1234567.89, 999999999.99, 1e9];
  const Original = Intl.NumberFormat;
  let constructions = 0;
  Intl.NumberFormat = new Proxy(Original, { construct(target, argumentsList) { constructions++; return Reflect.construct(target, argumentsList); } });
  try {
    for (const isEnglish of [false, true]) {
      const data: AnswerChartData = { type: "stacked-bar", title: "Numbers", unit: "", series: ["a", "b", "c", "d"],
        rows: values.map((value, index) => ({ label: `row${index}`, values: [value, 1, 2, 3] })) };
      const html = renderToStaticMarkup(createElement(AnswerChart, { data, isEnglish }));
      for (const [index, value] of values.entries()) {
        const expected = new Original(isEnglish ? "en-US" : "ko-KR", { maximumSignificantDigits: 21,
          notation: value !== 0 && (value < 0.0001 || value >= 1e9) ? "scientific" : "standard" }).format(value);
        assert.ok(html.includes(`row${index}: a ${expected}, b 1, c 2, d 3`));
      }
      assert.equal(renderToStaticMarkup(createElement(AnswerChart, { data, isEnglish })), html);
    }
    assert.equal(constructions, 0, "formatters are shared even when both full-size charts render twice");
  } finally { Intl.NumberFormat = Original; }
});
