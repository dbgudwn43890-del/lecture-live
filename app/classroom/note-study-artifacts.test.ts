import assert from "node:assert/strict";
import test from "node:test";
import { noteStudyArtifacts } from "./note-study-artifacts.ts";

const data = { type: "bar", title: "점수", unit: "점", series: ["점수"], rows: [{ label: "20명", values: [80] }, { label: "10명", values: [50] }] };
const fence = (chart: unknown, language = "lecue-chart") => `\`\`\`${language}\n${JSON.stringify(chart)}\n\`\`\``;
const saved = (text: string, id = "A1") => ({ id, questionId: "Q1", text });

test("extracts only valid explicit artifacts, retaining chart and check order without conversational prose", () => {
  const artifacts = noteStudyArtifacts([saved(`지금까지 강의 내용을 정리하면 다음과 같습니다.\n\n${fence(data)}\n\n### 확인 질문\n20명은 80점, 10명은 50점. 전체 평균은?\n\n### 정답\n70점. (20 × 80 + 10 × 50) ÷ 30 = 70.`)]);
  assert.deepEqual(artifacts, [
    { type: "chart", data },
    { type: "check", question: "20명은 80점, 10명은 50점. 전체 평균은?", answer: "70점. (20 × 80 + 10 × 50) ÷ 30 = 70." },
  ]);
});

test("deduplicates equivalent chart data only, and preserves changed practice conditions or answers", () => {
  const reordered = { rows: data.rows, series: data.series, unit: data.unit, title: data.title, type: data.type };
  const changed = { ...data, rows: [{ label: "20명", values: [85] }, { label: "10명", values: [55] }] };
  const check = "### Check yourself\nWhat is the mean of 80 and 50?\n\n### Answer\n65";
  const artifacts = noteStudyArtifacts([
    saved(`${fence(data)}\n\n${check}`), saved(`${fence(reordered, "json")}\n\n${check}`, "A2"),
    saved(`${fence(changed)}\n\n${check.replace("80", "90").replace("65", "70")}`, "A3"),
    saved(check.replace("65", "Correction: use the group counts."), "A4"),
  ]);
  assert.deepEqual(artifacts.filter(artifact => artifact.type === "chart").map(artifact => artifact.data), [data, changed]);
  assert.equal(artifacts.filter(artifact => artifact.type === "check").length, 3);
});

test("retains charts inside a practice in their original position, instead of extracting them twice", () => {
  const question = `Use this chart:\n\n${fence(data)}`;
  const artifacts = noteStudyArtifacts([saved(`Intro\n\n### 확인 질문\n${question}\n\n### 정답\n70점.`)]);
  assert.deepEqual(artifacts, [{ type: "check", question, answer: "70점." }]);
});

test("uses the existing chart trust boundary, including nested fences, without guessing from ordinary examples", () => {
  const nested = fence(data).split("\n").map(line => `> ${line}`).join("\n");
  const artifacts = noteStudyArtifacts([saved([
    "예제: 20명은 80점, 10명은 50점. 정답은 70점입니다.",
    fence(data, "bash"), fence({ ...data, url: "https://invalid.example/track" }),
    "```lecue-chart\ninvalid JSON\n```", nested,
    "````text\n### 확인 질문\n가짜 질문\n### 정답\n가짜 정답\n````",
  ].join("\n\n"))]);
  assert.deepEqual(artifacts, [{ type: "chart", data }]);
});
