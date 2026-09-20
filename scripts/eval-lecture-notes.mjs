/**
 * Synthetic-only note evaluation; no database, private PDFs, or app requests.
 * Offline: node --experimental-strip-types scripts/eval-lecture-notes.mjs
 * Paid:    node --experimental-strip-types scripts/eval-lecture-notes.mjs --live --language all
 * Narrow:  --case shell | --case weighted-average; optional --output /private/tmp/note-eval.json
 * Default dry-run validates hand-written reference notes and deliberately broken
 * variants. It does NOT measure model quality. Live runs use the production prompt,
 * schema and semantic validator, with the route's model/output/timeout settings.
 * Assertions cover explicit synthetic expectations, not all factual correctness,
 * translation quality, rendering, database persistence, or performance in real classes.
 * Raw generated output is saved only with --output; do not commit those artifacts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs, parseEnv } from "node:util";
import OpenAI from "openai";
import { notePrompt, noteSchema } from "../app/lib/lecture-note.ts";
import { noteClock, validateLectureNote } from "../app/lib/lecture-note-context.ts";

const MODEL = "gpt-5.6-luna";
const TIMEOUT_MS = 240_000;
const MAX_OUTPUT_TOKENS = 24_000;
const caseNames = ["shell", "weighted-average"];
const digest = value => createHash("sha256").update(value).digest("hex");
const blocks = note => (note?.sections ?? []).flatMap(section => section.blocks ?? []);
const visibleText = block => [block.label, block.text, block.code, block.latex, block.mermaid,
  ...(block.entries ?? []).flatMap(entry => [entry.text, ...(entry.children ?? [])]),
  ...(block.columns ?? []), ...(block.rows ?? []).flat()].filter(value => typeof value === "string").join("\n");

function prepare(fixture, language) {
  const english = language === "en";
  const evidence = { sources: new Map(), questions: new Set(), questionSources: new Map(), questionTurns: new Map(), answers: new Map(), documents: [] };
  const transcript = fixture.transcript.map(segment => {
    const clock = noteClock(segment.startMs);
    evidence.sources.set(segment.id, { id: segment.id, label: `${english ? "Lecture" : "강의"} ${clock}`, startMs: segment.startMs });
    return `[${segment.id} | ${clock}] ${segment.text}`;
  }).join("\n");
  const questions = fixture.questions.map(question => {
    const clock = noteClock(question.startMs);
    const source = { id: question.id, label: `${english ? "My question" : "내 질문"} ${clock}`, startMs: question.startMs };
    evidence.questionTurns.set(question.id, { text: question.text, source });
    if (question.answer) evidence.answers.set(question.id, [{ id: `synthetic-${fixture.id}-${question.id}`, questionId: question.id, text: question.answer }]);
    return `[${question.id} | ${clock}] ${question.text}${question.answer
      ? `\n${english ? "Saved AI answer (context for synthesis; original available separately)" : "저장된 AI 답변 (학습 정리의 맥락; 원문은 별도 보존)"}:\n${question.answer}` : ""}`;
  }).join("\n\n");
  const materials = (fixture.materials ?? []).map(material => {
    evidence.sources.set(material.id, { id: material.id, label: `${material.filename} p.${material.page}`, documentId: material.documentId, page: material.page });
    evidence.documents.push({ id: material.documentId, filename: material.filename, page_count: material.page, storage_path: null });
    return `### ${material.filename} (${english ? "text only" : "텍스트 전용"})\n[${material.id} | ${material.filename} p.${material.page}] ${material.text}`;
  }).join("\n\n");
  const input = [
    `# ${english ? "Lecture" : "수업"}: ${fixture.title}`,
    `## ${english ? "Transcript" : "강의 스크립트"}\n${transcript}`,
    `## ${english ? "Actual questions and saved AI answers (conversation history, not lecture evidence; Q IDs go in questionIds only)" : "실제 질문과 저장된 AI 답변 (강의 근거가 아닌 대화 기록이며, Q ID는 questionIds에만 넣음)"}\n${questions}`,
    materials ? `## ${english ? "Lecture materials (extracted text, not images)" : "강의 자료 (이미지가 아닌 추출 텍스트)"}\n${materials}` : "",
  ].filter(Boolean).join("\n\n");
  return { evidence, input };
}

function evaluate(fixture, raw, evidence) {
  const checks = [];
  const check = (name, run) => {
    try { run(); checks.push({ name, passed: true }); }
    catch { checks.push({ name, passed: false }); }
  };
  let note;
  check("production-validator", () => { note = validateLectureNote(raw, evidence); });
  const all = blocks(raw);
  const qa = all.filter(block => block.type === "qa");
  const excluded = raw?.excludedQuestions ?? [];
  const statusIds = fixture.questions.filter(question => question.disposition === "status_check").map(question => question.id);
  const learningIds = fixture.questions.filter(question => question.disposition === "keep").map(question => question.id);
  check("every-question-accounted-once", () => assert.deepEqual(
    [...qa.flatMap(block => block.questionIds ?? []), ...excluded.map(item => item.questionId)].sort(), fixture.questions.map(question => question.id).sort(),
  ));
  check("status-requests-excluded-not-qa", () => {
    assert.deepEqual(excluded.filter(item => item.reason === "status_check").map(item => item.questionId).sort(), [...statusIds].sort());
    assert.ok(qa.every(block => (block.questionIds ?? []).every(id => !statusIds.includes(id))));
    const visible = all.map(visibleText).join("\n");
    for (const question of fixture.questions.filter(question => statusIds.includes(question.id))) assert.ok(!visible.includes(question.text));
  });
  check("clarification-and-mixed-requests-retained", () => {
    assert.deepEqual(qa.flatMap(block => block.questionIds ?? []).sort(), [...learningIds].sort());
    assert.ok(qa.every(block => typeof block.text === "string" && block.text.trim()));
  });
  check("lecture-blocks-use-only-real-T-M-evidence", () => {
    const lecture = all.filter(block => block.type !== "qa");
    assert.ok(lecture.length);
    for (const block of lecture) {
      assert.ok(block.sourceIds?.length);
      assert.ok(block.sourceIds.every(id => /^(?:T[1-9][0-9]*|M[1-9][0-9]*P[1-9][0-9]*)$/.test(id) && evidence.sources.has(id)));
    }
  });
  check("saved-answers-and-chart-data-verbatim", () => {
    assert.ok(note);
    for (const block of blocks(note).filter(block => block.type === "qa")) {
      assert.deepEqual(block.originalAnswers ?? [], block.questionIds.flatMap(id => evidence.answers.get(id) ?? []));
    }
  });
  check("meaningful-representation", () => assert.ok(all.some(block => {
    if (!fixture.expect.representations.includes(block.type)) return false;
    if (block.type === "steps") return block.entries?.length >= 2;
    if (block.type === "table") return block.columns?.length >= 2 && block.rows?.length >= 2;
    if (block.type === "diagram") return /-->|mindmap/.test(block.mermaid ?? "");
    return block.type === "code" && Boolean(block.code?.trim());
  })));
  check("check-labels-ask-specific-questions", () => {
    for (const block of all.filter(block => block.type === "check")) {
      assert.ok(block.label?.trim().length >= 8);
      assert.doesNotMatch(block.label.trim(), /^(?:복습\s*(?:질문|문제)|확인\s*(?:질문|문제)|연습\s*문제|이해도\s*확인|check\s*(?:your\s*)?understanding|review\s*(?:question|exercise)|practice\s*(?:question|exercise))\s*\d*[.!?:：]*$/i);
    }
  });
  if (fixture.expect.code?.length) check("exact-command-characters-preserved", () => {
    const code = all.map(visibleText).join("\n");
    for (const command of fixture.expect.code) assert.ok(code.includes(command));
  });
  if (fixture.expect.lectureNumbers?.length) check("lecture-numbers-preserved", () => {
    const lecture = all.filter(block => block.type !== "qa").map(visibleText).join("\n");
    for (const number of fixture.expect.lectureNumbers) assert.match(lecture, new RegExp(`(^|[^0-9])${number}([^0-9]|$)`));
  });
  for (const practice of fixture.expect.practice ?? []) check(`saved-practice-values-${practice.questionId}`, () => {
    const answer = qa.find(block => block.questionIds?.includes(practice.questionId));
    assert.ok(answer);
    for (const number of practice.numbers) assert.match(answer.text, new RegExp(`(^|[^0-9])${number}([^0-9]|$)`));
    for (const number of practice.forbiddenNumbers ?? []) assert.doesNotMatch(answer.text, new RegExp(`(^|[^0-9])${number}([^0-9]|$)`));
  });
  return { passed: checks.every(check => check.passed), checks, note };
}

function verifyOfflineOracles(fixture, evidence) {
  const mutations = [
    raw => { raw.sections.flatMap(section => section.blocks).find(block => block.type === "qa").questionIds = []; },
    raw => { raw.sections.flatMap(section => section.blocks).find(block => block.type !== "qa").sourceIds = ["Q999"]; },
    raw => { raw.excludedQuestions = []; },
    raw => { raw.sections.flatMap(section => section.blocks).find(block => block.type === "check").label = "복습 문제"; },
  ];
  if (fixture.expect.code?.length) mutations.push(raw => { raw.sections.flatMap(section => section.blocks).find(block => block.type === "code").code = "cut -f2 scores.csv"; });
  if (fixture.expect.practice?.length) mutations.push(raw => { raw.sections.flatMap(section => section.blocks).find(block => block.questionIds?.includes(fixture.expect.practice[0].questionId)).text = "10명은 90점, 30명은 70점이며 평균은 75점이다."; });
  return mutations.every(mutate => {
    const broken = structuredClone(fixture.reference);
    mutate(broken);
    return !evaluate(fixture, broken, evidence).passed;
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false },
    case: { type: "string" }, language: { type: "string", default: "ko" }, output: { type: "string" }, help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("node --experimental-strip-types scripts/eval-lecture-notes.mjs [--dry-run | --live] [--case shell|weighted-average] [--language ko|en|all] [--output /private/tmp/note-eval.json]\nDefault: offline fixture/oracle checks, zero API calls. --live spends API tokens. --output saves raw synthetic model output; no raw output is printed.");
    return;
  }
  assert.ok(!(values.live && values["dry-run"]), "choose --live or --dry-run");
  assert.ok(["ko", "en", "all"].includes(values.language), "invalid language");
  assert.ok(!values.case || caseNames.includes(values.case), "invalid case");
  const languages = values.language === "all" ? ["ko", "en"] : [values.language];
  const fixtures = await Promise.all((values.case ? [values.case] : caseNames).map(async name => JSON.parse(await readFile(new URL(`./fixtures/lecture-note-${name}.json`, import.meta.url), "utf8"))));
  let client;
  if (values.live) {
    let key = process.env.OPENAI_API_KEY;
    if (!key) {
      try { key = parseEnv(await readFile(new URL("../.env.local", import.meta.url), "utf8")).OPENAI_API_KEY; }
      catch { /* Report missing credentials without file contents or errors. */ }
    }
    if (!key) throw new Error("OPENAI_API_KEY unavailable; no requests made");
    client = new OpenAI({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: 0 });
  }
  const report = { createdAt: new Date().toISOString(), mode: values.live ? "live" : "dry-run", model: MODEL, store: false, maxRetries: 0, timeoutMs: TIMEOUT_MS, maxOutputTokens: MAX_OUTPUT_TOKENS, results: [] };
  for (const fixture of fixtures) for (const language of languages) {
    const { input, evidence } = prepare(fixture, language);
    const instructions = notePrompt(language), schema = noteSchema(language);
    const started = performance.now();
    let raw, outputText, usage;
    let result;
    try {
      if (client) {
        const response = await client.responses.create({ model: MODEL, max_output_tokens: MAX_OUTPUT_TOKENS, store: false, instructions, input,
          text: { format: { type: "json_schema", name: "lecture_note", strict: true, schema } } });
        usage = response.usage;
        outputText = response.output_text;
        if (response.status !== "completed") throw new Error("incomplete response");
        raw = JSON.parse(outputText);
      } else raw = structuredClone(fixture.reference);
      result = evaluate(fixture, raw, evidence);
      if (!client) {
        const passed = verifyOfflineOracles(fixture, evidence);
        result.checks.push({ name: "broken-fixtures-rejected", passed });
        result.passed &&= passed;
      }
    } catch (error) {
      result = { passed: false, checks: [{ name: error instanceof OpenAI.APIError ? "provider-response" : "generation-or-evaluation", passed: false }],
        ...(error instanceof OpenAI.APIError ? { providerStatus: error.status } : {}) };
    }
    const latencyMs = Math.round(performance.now() - started);
    const tokens = { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0, reasoning: usage?.output_tokens_details?.reasoning_tokens ?? 0 };
    console.log(`${result.passed ? "PASS" : "FAIL"} ${report.mode} ${fixture.id}/${language} | ${result.checks.map(check => `${check.name}:${check.passed ? "pass" : "FAIL"}`).join(" ")} | ${latencyMs}ms | tokens ${tokens.input}/${tokens.output} reasoning ${tokens.reasoning}`);
    report.results.push({ case: fixture.id, language, passed: result.passed, checks: result.checks, latencyMs, tokens, promptSha256: digest(instructions), schemaSha256: digest(JSON.stringify(schema)),
      ...(values.output ? { input, outputText, raw, note: result.note, providerStatus: result.providerStatus } : {}) });
  }
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  if (report.results.some(result => !result.passed)) process.exitCode = 1;
}

main().catch(() => { console.error("FAIL evaluation setup: check flags, fixture files, credentials (--live only), and output path; use --help."); process.exitCode = 1; });
