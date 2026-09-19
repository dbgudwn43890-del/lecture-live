/**
 * Four synthetic-only provider evaluations; no database or application requests.
 * Run: node --experimental-strip-types scripts/eval-note-curation.ts
 * Optional: --output /private/tmp/lecture-note-eval.json
 * Uses OPENAI_API_KEY from the environment or .env.local; never records secrets.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import OpenAI from "openai";
import { notePrompt, noteSchema, type LectureNote, type NoteBlock } from "../app/lib/lecture-note.ts";
import { validateLectureNote, type NoteEvidence } from "../app/lib/lecture-note-context.ts";

type Question = { text: string; answer?: string };
type Case = {
  name: string;
  language: "en" | "ko";
  transcript: string[];
  questions: Question[];
  groups: string[][];
  excluded: string[];
  numbers?: { questionId: string; values: number[] }[];
};

const koExplanation = "기존 채권의 약정 현금 흐름은 고정되어 있다. 시장 금리가 오르면 그 현금 흐름을 더 높은 할인율로 할인하므로 현재 가치인 가격이 내려간다.";
const enExplanation = "A bond's promised cash flows are fixed. A higher market rate discounts those same cash flows more heavily, reducing their present value and the bond's price.";
const chartAnswer = '20명은 80점, 10명은 50점이다. 전체 평균은 (20 × 80 + 10 × 50) ÷ 30 = 70점이다.\n\n```lecue-chart\n{"type":"bar","title":"집단별 점수","unit":"점","series":["점수"],"rows":[{"label":"20명","values":[80]},{"label":"10명","values":[50]}]}\n```';
const cases: Case[] = [
  {
    name: "korean-intent-groups", language: "ko",
    transcript: [
      "기존 고정금리 채권의 가격은 약정 현금 흐름을 시장 금리로 할인한 현재 가치다. 현금 흐름이 같으면 시장 금리가 오를수록 가격은 내려간다.",
      "시장 금리가 내려가면 할인율이 낮아져 같은 현금 흐름의 현재 가치는 커진다. 만기, 현금 흐름, 신용 조건이 같은 상황을 비교한다.",
    ],
    questions: [
      { text: "금리 올라가면 채권값은 왜 떨어져?", answer: koExplanation },
      { text: "그러니까 이자율 높아지면 가격 내려간다는 거임?", answer: koExplanation },
      { text: "아직 모르겠어 더 쉽게", answer: "똑같은 미래의 돈을 받을 때, 시장에서 새로 받을 수 있는 이자가 높아지면 기존 약속에는 지금 더 적게 지불한다는 뜻이다." },
      { text: "왜?" },
      { text: "반대로 금리가 내려가는 경우엔 어떻게 돼?", answer: "같은 고정 현금 흐름을 더 낮은 할인율로 할인하므로 채권 가격은 오른다." },
      { text: "ㅋㅋ 고마워", answer: "도움이 되었다니 다행이에요!" },
      { text: "입력 테스트 123", answer: "입력 확인했습니다." },
      { text: "강의랑 상관없이 오늘 저녁 메뉴 추천해 줘", answer: "피자를 먹어 보세요." },
    ],
    groups: [["Q1", "Q2", "Q3", "Q4"], ["Q5"]], excluded: ["Q6", "Q7", "Q8"],
  },
  {
    name: "english-intent-groups", language: "en",
    transcript: [
      "The price of an existing fixed-rate bond is the present value of its promised cash flows discounted at the market rate. With unchanged cash flows, a higher market rate produces a lower price.",
      "When the market rate falls, discounting is less severe and the same cash flows have a higher present value. Compare otherwise unchanged maturity, cash flows and credit conditions.",
    ],
    questions: [
      { text: "why does the bond price drop when rates go up?", answer: enExplanation },
      { text: "so higher interest means lower price, right?", answer: enExplanation },
      { text: "still confused, simpler please", answer: "If new investments pay more interest, people pay less today for an old bond promising the same unchanged payments." },
      { text: "why?" },
      { text: "What happens in the opposite case, when rates fall?", answer: "The same fixed cash flows are discounted at a lower rate, so the bond's price increases." },
      { text: "lol thanks!", answer: "You're welcome!" },
      { text: "just testing the input 123", answer: "Your input was received." },
      { text: "Unrelated to class: recommend something for dinner", answer: "Try pizza." },
    ],
    groups: [["Q1", "Q2", "Q3", "Q4"], ["Q5"]], excluded: ["Q6", "Q7", "Q8"],
  },
  {
    name: "distinct-practice-and-graph", language: "ko",
    transcript: [
      "집단별 평균을 합칠 때 각 평균에 인원수를 곱하고 전체 인원수로 나눈다. 집단 크기가 다르면 단순히 두 평균을 더해 2로 나누면 안 된다.",
      "강의 예제는 10명이 80점, 다른 10명이 70점이다. 전체 평균은 (10 곱하기 80 더하기 10 곱하기 70) 나누기 20으로 75점이다.",
    ],
    questions: [
      { text: "강의 거 말고 다른 숫자로 연습문제 줘", answer: chartAnswer },
      { text: "그 20명 10명 예제를 그래프로 보여줘", answer: chartAnswer },
      { text: "이번엔 2명이 100점이고 3명이 40점일 때도 계산해 줘", answer: "(2 × 100 + 3 × 40) ÷ 5 = 64점이다. 집단별 인원수 2와 3이 가중치다." },
      { text: "ㅇㅋ 고마워" },
    ],
    groups: [["Q1", "Q2"], ["Q3"]], excluded: ["Q4"],
    numbers: [{ questionId: "Q1", values: [20, 80, 10, 50, 70] }, { questionId: "Q3", values: [2, 100, 3, 40, 64] }],
  },
  {
    name: "all-chatter-no-qa", language: "en",
    transcript: ["A derivative describes the instantaneous rate of change. For f(x) = x squared, the derivative is 2x. At x = 3, the rate is 6."],
    questions: [
      { text: "hello, just checking the chat works", answer: "Hello! The chat is working." },
      { text: "thanks bye!", answer: "Goodbye!" },
      { text: "Unrelated to the lesson, tell me a joke about pizza", answer: "A pizza joke belongs outside these calculus notes." },
    ],
    groups: [], excluded: ["Q1", "Q2", "Q3"],
  },
];

function fixture(item: Case): { input: string; evidence: NoteEvidence } {
  const evidence: NoteEvidence = { sources: new Map(), questions: new Set(), questionSources: new Map(), answers: new Map(), documents: [] };
  const transcript = item.transcript.map((text, index) => {
    const id = `T${index + 1}`;
    evidence.sources.set(id, { id, label: `Lecture ${index + 1}:00`, startMs: (index + 1) * 60_000 });
    return `[${id} | ${index + 1}:00] ${text}`;
  }).join("\n");
  const questions = item.questions.map((question, index) => {
    const id = `Q${index + 1}`;
    evidence.questions.add(question.text);
    evidence.questionSources.set(question.text, { id, label: `Question ${index + 1}`, startMs: 120_000 + index * 10_000 });
    if (question.answer) evidence.answers!.set(id, [{ id: `synthetic-answer-${index + 1}`, questionId: id, text: question.answer }]);
    return `[${id} | 2:${String(index * 10).padStart(2, "0")}] ${question.text}${question.answer ? `\nSaved AI answer (conversation history):\n${question.answer}` : ""}`;
  }).join("\n\n");
  return { evidence, input: `# Synthetic lecture\n## Transcript\n${transcript}\n\n## Actual student questions and saved AI answers (conversation history, not lecture evidence)\n${questions}` };
}

function checkResult(item: Case, raw: unknown, note: LectureNote, evidence: NoteEvidence) {
  const checks: { name: string; passed: boolean; detail?: string }[] = [];
  function check(name: string, run: () => void) {
    try { run(); checks.push({ name, passed: true }); }
    catch { checks.push({ name, passed: false }); }
  }
  const qa = note.sections.flatMap(section => section.blocks).filter(block => block.type === "qa");
  check("exact learning-intent groups", () => assert.deepEqual(
    qa.map(block => [...(block.questionIds ?? [])].sort().join(",")).sort(),
    item.groups.map(group => [...group].sort().join(",")).sort(),
  ));
  const excluded = (raw as { excludedQuestions: { questionId: string }[] }).excludedQuestions;
  check("clear chatter and off-topic IDs excluded", () => assert.deepEqual(excluded.map(item => item.questionId).sort(), [...item.excluded].sort()));
  check("nonempty concise visible synthesis", () => assert.ok(qa.every(block => block.text.trim().length > 0 && block.text.length <= 1_000)));
  check("saved answers remain verbatim", () => {
    for (const block of qa) {
      const originals = block.questionIds!.flatMap(id => evidence.answers!.get(id) ?? []);
      assert.deepEqual(block.originalAnswers ?? [], originals);
    }
  });
  check("no clear chatter leaks into visible content", () => {
    const visible = [note.title, note.summary, ...(note.keyPoints ?? []), ...note.sections.flatMap(section => [section.heading, ...section.blocks.map(block => block.text)])].join("\n");
    assert.doesNotMatch(visible, /피자|pizza|ㅋㅋ 고마워|입력 테스트|just testing the input|thanks bye/i);
  });
  if (item.numbers) {
    check("practice values survive synthesis without lecture substitution", () => {
      for (const target of item.numbers!) {
        const block = qa.find(block => block.questionIds?.includes(target.questionId));
        assert.ok(block);
        for (const value of target.values) assert.match(block.text, new RegExp(`(^|\\D)${value}(\\D|$)`));
        assert.doesNotMatch(block.text, /(^|\D)75(\D|$)/);
      }
    });
    check("original chart is preserved", () => assert.ok(qa.some(block => block.originalAnswers?.some(answer => answer.text.includes("```lecue-chart") && answer.text.includes('"values":[80]')))));
  }
  return { checks, qa: qa.map(({ label, text, questionIds }: NoteBlock) => ({ label, text, questionIds })) };
}

const outputFlag = process.argv.indexOf("--output");
const outputPath = outputFlag >= 0 ? process.argv[outputFlag + 1] : `/private/tmp/lecue-note-curation-eval-${new Date().toISOString().slice(0, 10)}.json`;
if (!outputPath) throw new Error("--output requires a file path");
if (!process.env.OPENAI_API_KEY) {
  try { process.loadEnvFile(".env.local"); } catch { /* Report only missing credentials, never file contents. */ }
}
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY unavailable; no provider calls made");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 180_000 });
const model = "gpt-5.6-luna";
const report = {
  createdAt: new Date().toISOString(), model, syntheticOnly: true, store: false, maxRetries: 0, maxOutputTokens: 6_000,
  promptHashes: Object.fromEntries(["en", "ko"].map(language => [language, createHash("sha256").update(notePrompt(language as "en" | "ko")).digest("hex")])),
  results: await Promise.all(cases.map(async item => {
    const start = Date.now();
    const { input, evidence } = fixture(item);
    let raw: unknown;
    try {
      const response = await client.responses.create({
        model, store: false, max_output_tokens: 6_000,
        instructions: notePrompt(item.language), input,
        text: { format: { type: "json_schema", name: "lecture_note", strict: true, schema: noteSchema(item.language) as unknown as Record<string, unknown> } },
      });
      if (response.status !== "completed") return { name: item.name, passed: false, responseStatus: response.status, elapsedMs: Date.now() - start, usage: response.usage };
      raw = JSON.parse(response.output_text);
      const note = validateLectureNote(raw, evidence);
      const result = checkResult(item, raw, note, evidence);
      const passed = result.checks.every(check => check.passed);
      console.log(`${passed ? "PASS" : "FAIL"} ${item.name}: ${result.checks.filter(check => check.passed).length}/${result.checks.length}`);
      return { name: item.name, passed, elapsedMs: Date.now() - start, usage: response.usage, ...result, syntheticInput: input, raw, note };
    } catch (error) {
      const provider = error instanceof OpenAI.APIError;
      const detail = provider ? { status: error.status, code: error.code } : { validationError: error instanceof Error ? error.message : "unknown error" };
      console.log(`ERROR ${item.name}: ${provider ? `provider status ${error.status ?? "unknown"}` : "validation or transport failure"}`);
      return { name: item.name, passed: false, elapsedMs: Date.now() - start, error: detail, ...(raw ? { raw } : {}) };
    }
  })),
};
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(`Synthetic evaluation report: ${outputPath}`);
if (report.results.some(result => !result.passed)) process.exitCode = 1;
