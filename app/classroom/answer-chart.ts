import { createElement, type CSSProperties } from "react";

export const ANSWER_CHART_LANGUAGE = "lecue-chart";
const MAX_CHART_BYTES = 8_000;

export type AnswerChartData = {
  type: "bar" | "stacked-bar";
  title: string;
  unit: string;
  series: string[];
  rows: { label: string; values: number[] }[];
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const label = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

/** Model output is data only: no HTML, colors, URLs, expressions, or chart code. */
export function parseAnswerChart(source: string): AnswerChartData | null {
  if (source.length > MAX_CHART_BYTES) return null;
  try {
    const data: unknown = JSON.parse(source);
    if (!record(data) || !onlyKeys(data, ["type", "title", "unit", "series", "rows"])) return null;
    if (data.type !== "bar" && data.type !== "stacked-bar") return null;
    if (!label(data.title, 100) || (data.unit !== undefined && data.unit !== "" && !label(data.unit, 20))) return null;
    if (!Array.isArray(data.series) || data.series.length < 1 || data.series.length > 4 || !data.series.every(item => label(item, 40))) return null;
    const series: string[] = data.series.map(item => item.trim());
    if (new Set(series).size !== series.length || (data.type === "bar" ? series.length !== 1 : series.length < 2)) return null;
    if (!Array.isArray(data.rows) || data.rows.length < 2 || data.rows.length > 8) return null;
    const rows: AnswerChartData["rows"] = [];
    for (const row of data.rows) {
      if (!record(row) || !onlyKeys(row, ["label", "values"]) || !label(row.label, 60)) return null;
      if (!Array.isArray(row.values) || row.values.length !== series.length) return null;
      if (!row.values.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12)) return null;
      if (data.type === "stacked-bar" && row.values.every(value => value === 0)) return null;
      rows.push({ label: row.label.trim(), values: row.values as number[] });
    }
    if (new Set(rows.map(row => row.label)).size !== rows.length) return null;
    if (data.type === "bar" && rows.every(row => row.values[0] === 0)) return null;
    return { type: data.type, title: data.title.trim(), unit: typeof data.unit === "string" ? data.unit.trim() : "", series, rows };
  } catch {
    return null;
  }
}

function formatValue(value: number, isEnglish: boolean) {
  return new Intl.NumberFormat(isEnglish ? "en-US" : "ko-KR", {
    maximumSignificantDigits: 21,
    notation: value !== 0 && (value < 0.0001 || value >= 1e9) ? "scientific" : "standard",
  }).format(value);
}

export function AnswerChart({ data, pending = false, isEnglish = false }: { data: AnswerChartData | null; pending?: boolean; isEnglish?: boolean }) {
  if (!data) return createElement("p", { className: "answer-chart-status", role: pending ? "status" : undefined }, pending
    ? isEnglish ? "Preparing the chart…" : "그래프를 정리하고 있어요…"
    : isEnglish ? "The chart format could not be read. See the explanation above." : "그래프 형식을 읽지 못했어요. 본문 설명을 확인해 주세요.");

  const stacked = data.type === "stacked-bar";
  const maximum = Math.max(...data.rows.map(row => row.values[0]));
  const number = (value: number) => formatValue(value, isEnglish);
  const valueWithUnit = (value: number) => `${number(value)}${data.unit ? ` ${data.unit}` : ""}`;
  return createElement("figure", { className: "answer-chart", "data-chart-type": data.type, "aria-label": data.title },
    createElement("figcaption", { className: "answer-chart-caption" },
      createElement("strong", null, data.title),
      createElement("span", null, stacked
        ? isEnglish ? `Share within each group${data.unit ? ` · Values in ${data.unit}` : ""}` : `각 그룹 안의 구성 비율${data.unit ? ` · 단위: ${data.unit}` : ""}`
        : isEnglish ? `Common scale from 0${data.unit ? ` · Values in ${data.unit}` : ""}` : `0부터 같은 눈금으로 비교${data.unit ? ` · 단위: ${data.unit}` : ""}`),
    ),
    createElement("div", { className: "answer-chart-legend" }, ...data.series.map((series, index) => createElement("span", { key: series },
      stacked ? createElement("i", { className: "answer-chart-swatch", "data-color": index, "aria-hidden": true }) : null, series,
    ))),
    createElement("div", { className: "answer-chart-rows" }, ...data.rows.map((row, rowIndex) => {
      const total = row.values.reduce((sum, value) => sum + value, 0);
      const description = row.values.map((value, index) => `${data.series[index]} ${valueWithUnit(value)}`).join(", ");
      return createElement("div", { className: "answer-chart-row", key: row.label },
        createElement("span", { className: "answer-chart-row-label" }, row.label),
        createElement("div", { className: "answer-chart-track", role: "img", "aria-label": `${row.label}: ${description}` }, ...row.values.map((value, index) => createElement("span", {
          key: data.series[index], className: "answer-chart-segment", "data-series": index,
          "data-color": stacked ? index : rowIndex,
          style: { width: `${value / (stacked ? total : maximum) * 100}%` } as CSSProperties,
          title: `${data.series[index]}: ${valueWithUnit(value)}`, "aria-hidden": true,
        }))),
        createElement("span", { className: "answer-chart-values", "aria-hidden": true }, row.values.map(number).join(" : ")),
      );
    })),
  );
}
