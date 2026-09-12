import assert from "node:assert/strict";
import test from "node:test";
import { validateLectureNote, type NoteEvidence } from "./lecture-note-context.ts";
import { NOTE_KEY_POINT_MAX_LENGTH, NOTE_SCHEMA, NOTE_SUMMARY_MAX_LENGTH, NOTE_SUMMARY_KOREAN_MAX_LENGTH, notePrompt, noteSchema } from "./lecture-note.ts";

function evidence(): NoteEvidence {
  return {
    sources: new Map([
      ["T1", { id: "T1", label: "강의 1:05", startMs: 65_000 }],
      ["M1P2", { id: "M1P2", label: "slides.pdf · p.2", documentId: "document-1", page: 2 }],
      ["M2P2", { id: "M2P2", label: "slides.pdf · p.2", documentId: "document-2", page: 2 }],
    ]),
    questions: new Set(), questionSources: new Map(),
    documents: [
      { id: "document-1", filename: "slides.pdf", page_count: 2, storage_path: "one.pdf" },
      { id: "document-2", filename: "slides.pdf", page_count: 2, storage_path: "two.pdf" },
    ],
  };
}
function raw(blocks: unknown[], concepts: unknown[] = []) {
  return { title: "미분", summary: "순간 변화율을 구한다.", keyPoints: ["미분은 순간 변화율"], sections: [{ heading: "개념", blocks }], concepts };
}
const paragraph = { type: "paragraph", text: "설명", sourceIds: ["T1"] };

test("the compact block union keeps the strict structured-output object contract", () => {
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    const schema = value as Record<string, unknown>;
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...(schema.required as string[])].sort(), Object.keys(schema.properties as object).sort());
    }
    for (const child of Object.values(schema)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  }
  visit(NOTE_SCHEMA);
  assert.equal(NOTE_SCHEMA.type, "object");
  assert.ok(!("anyOf" in NOTE_SCHEMA), "only nested blocks use anyOf");
  const variants = NOTE_SCHEMA.properties.sections.items.properties.blocks.items.anyOf;
  const paragraph = variants.find(variant => variant.properties.type.enum.includes("paragraph"));
  assert.deepEqual(paragraph?.required, ["type", "sourceIds", "text"], "paragraphs do not spend tokens on unused table/formula fields");
  assert.equal(NOTE_SCHEMA.properties.keyPoints.maxItems, 5);
  assert.equal(NOTE_SCHEMA.properties.keyPoints.items.maxLength, NOTE_KEY_POINT_MAX_LENGTH);
  assert.equal(NOTE_KEY_POINT_MAX_LENGTH, 100);
});

test("compact generation limits do not reject or clip an older detailed overview", () => {
  const title = "표본 수가 작은 경우의 검정";
  const summary = "정규성 가정이 충족되지 않으면 같은 검정 방법을 그대로 적용하지 않는다.";
  const korean = "검정 결과는 표본을 뽑은 방법과 정규성 가정에 따라 달라지므로, 표본 수가 작다는 이유만으로 해당 검정을 항상 쓸 수 없다고 판단하면 안 된다. 단, 독립성 가정이 충족되지 않으면 이 수업에서 배운 절차를 그대로 적용하지 않는다.";
  const english = "Use the quoted $10 price only when the stated assumptions hold, the sample is independent, and the contract does not exclude the measured condition; it is not a guaranteed price for every case.";
  const points = [korean, english, "유의수준: 5%", "가정이 다르면 결론도 달라짐", "표본의 독립성 확인", "단위: 원", "추가 조건은 원문 유지"];
  assert.ok(korean.length > NOTE_KEY_POINT_MAX_LENGTH && english.length > NOTE_KEY_POINT_MAX_LENGTH);
  const result = validateLectureNote({ ...raw([paragraph]), title, summary, keyPoints: points }, evidence());
  assert.equal(result.title, title);
  assert.equal(result.summary, summary);
  assert.deepEqual(result.keyPoints, points, "the reader may fold them, but validation must not discard qualifiers or overflow items");
});

test("Korean generation uses a 60-character point limit without mutating English or shared schema fields", () => {
  const korean = noteSchema(false);
  const english = noteSchema(true);
  assert.equal(korean.properties.keyPoints.items.maxLength, 60);
  assert.equal(english.properties.keyPoints.items.maxLength, 100);
  assert.equal(NOTE_SCHEMA.properties.keyPoints.items.maxLength, 100);
  assert.equal(korean.properties.keyPoints.maxItems, 5);
  assert.equal(english.properties.keyPoints.maxItems, 5);
  const koreanBlocks = korean.properties.sections.items.properties.blocks.items.anyOf;
  const englishBlocks = english.properties.sections.items.properties.blocks.items.anyOf;
  for (const block of koreanBlocks.filter(block => !block.properties.type.enum.includes("qa"))) {
    assert.ok(englishBlocks.includes(block), "only question labels need a locale-specific block schema");
  }
  assert.equal(korean.properties.concepts, english.properties.concepts);
  assert.equal(korean.required, english.required);
});

test("one-line summary constraints are locale-specific while older summaries remain intact", () => {
  const korean = noteSchema(false).properties.summary;
  const english = noteSchema(true).properties.summary;
  assert.equal(korean.maxLength, NOTE_SUMMARY_KOREAN_MAX_LENGTH);
  assert.equal(english.maxLength, NOTE_SUMMARY_MAX_LENGTH);
  assert.equal(NOTE_SCHEMA.properties.summary.maxLength, 140);
  assert.equal(NOTE_SUMMARY_KOREAN_MAX_LENGTH, 60);
  for (const summary of [korean, english]) {
    assert.ok(new RegExp(summary.pattern).test("조건이 맞을 때만 적용한다."));
    assert.ok(!new RegExp(summary.pattern).test("첫 번째 문장\n두 번째 문장"));
  }
  const previousSummary = "표본이 독립이고 분포 가정이 충족된 경우에만 이 결론을 사용할 수 있으며, ".repeat(6) + "그 밖의 경우에는 같은 결과를 보장하지 않는다.";
  const result = validateLectureNote({ ...raw([paragraph]), summary: previousSummary }, evidence());
  assert.equal(result.summary, previousSummary, "an older note must retain its conditions instead of being clipped to the new generation limit");
});

test("short bullet overviews keep simple lectures short and preserve originals behind the rewritten question", () => {
  const input = evidence();
  const question = "강사가 강조한 핵심이 뭐야? **이 표현**도 설명해 줘.";
  input.questions.add(question);
  input.questionSources.set(question, { id: "Q1", label: "내 질문 1:20", startMs: 80_000 });
  const label = "핵심 개념과 이 표현은 무슨 뜻인가?";
  const result = validateLectureNote({ ...raw([{ type: "qa", label, questionIds: ["Q1"], text: "근거로 확인한 설명", sourceIds: ["T1"] }]), keyPoints: ["미분: 순간 변화율"] }, input);
  assert.deepEqual(result.keyPoints, ["미분: 순간 변화율"], "never pad a simple lecture to three or five items");
  assert.equal(result.sections[0].blocks[0].label, label);
  assert.deepEqual(result.sections[0].blocks[0].originalQuestions, [{ id: "Q1", text: question }], "the short label must not replace or rewrite the stored original");
});

test("normalizes concise structured blocks while preserving hierarchy, empty table cells, and a separate practice answer", () => {
  const note = validateLectureNote(raw([
    { type: "steps", entries: [{ text: "미분한다", children: ["지수를 앞으로 옮긴다"] }, { text: "대입한다", children: [] }], sourceIds: ["T1"] },
    { type: "table", text: "차이", columns: ["구분", "의미"], rows: [["미분", "변화율"], ["", "기울기"]], sourceIds: ["T1"] },
    { type: "formula", latex: "f'(x)=6x", text: "변화율", sourceIds: ["T1"] },
    { type: "check", label: "x=2라면?", hint: "도함수에 대입", text: "12. 6×2이기 때문이다.", sourceIds: ["T1"] },
  ]), evidence());
  const blocks = note.sections[0].blocks;
  assert.deepEqual(blocks[0].entries?.[0].children, ["지수를 앞으로 옮긴다"]);
  assert.deepEqual(blocks[0].items, ["미분한다", "대입한다"]);
  assert.deepEqual(blocks[1].rows?.[1], ["", "기울기"]);
  assert.equal(blocks[3].label, "x=2라면?");
  assert.equal(blocks[3].text, "12. 6×2이기 때문이다.");
  assert.equal(blocks[3].hint, "도함수에 대입");
});

test("attaches question provenance only after matching real IDs and never trusts model-written originals or locations", () => {
  const input = evidence();
  input.questions.add("왜 그래?");
  input.questionSources.set("왜 그래?", { id: "Q1", label: "내 질문 1:20", startMs: 80_000 });
  const result = validateLectureNote(raw([{ type: "qa", label: "이 결론이 성립하는 이유는?", questionIds: ["Q1"], text: "설명", sourceIds: ["T1"], originalQuestions: [{ id: "Q1", text: "모델이 지어낸 원문" }], sources: [{ id: "Q999", startMs: 99 }], documentId: "invented" }]), input);
  const block = result.sections[0].blocks[0];
  assert.deepEqual(block.sources?.map(source => [source.id, source.startMs]), [["T1", 65_000], ["Q1", 80_000]]);
  assert.equal(block.documentId, undefined);
  assert.deepEqual(block.originalQuestions, [{ id: "Q1", text: "왜 그래?" }]);
  assert.throws(() => validateLectureNote(raw([{ type: "qa", label: "내가 묻지 않은 질문", questionIds: ["Q999"], text: "답", sourceIds: ["T1"] }]), input), /invented student question/);
  assert.throws(() => validateLectureNote(raw([paragraph]), input), /student question omitted/);
});

test("a concise question group covers related originals once and keeps distinct conditions in another group", () => {
  const input = evidence();
  const originals = ["금리가 오를 때 채권 가격은 왜 내려가요?", "이자율 상승이 채권값을 떨어뜨리는 이유를 다시 설명해 줘.", "금리가 내려가는 경우에는 채권 가격도 내려가나요?"];
  originals.forEach((question, index) => {
    input.questions.add(question);
    input.questionSources.set(question, { id: `Q${index + 1}`, label: `내 질문 ${index + 1}`, startMs: 80_000 + index * 5_000 });
  });
  const result = validateLectureNote(raw([
    { type: "qa", label: "금리가 오르면 채권 가격은 왜 내리는가?", questionIds: ["Q1", "Q2"], text: "기존 채권의 고정 현금 흐름을 더 높은 이자율로 할인하기 때문이다.", sourceIds: ["T1"] },
    { type: "qa", label: "금리가 내리면 채권 가격은 어떻게 되는가?", questionIds: ["Q3"], text: "같은 현금 흐름의 할인율이 낮아지면 현재 가치는 커진다.", sourceIds: ["T1"] },
  ]), input);
  assert.equal(result.sections[0].blocks.length, 2);
  const [combined, separate] = result.sections[0].blocks;
  assert.deepEqual(combined.questionIds, ["Q1", "Q2"]);
  assert.deepEqual(combined.originalQuestions, originals.slice(0, 2).map((text, index) => ({ id: `Q${index + 1}`, text })));
  assert.deepEqual(combined.sources?.map(source => source.id), ["T1", "Q1", "Q2"]);
  assert.deepEqual(combined.sourceIds, ["T1"], "question IDs are provenance, never factual evidence");
  assert.deepEqual(separate.originalQuestions, [{ id: "Q3", text: originals[2] }]);
});

test("question coverage rejects empty, unknown, repeated and omitted IDs instead of silently losing a question", () => {
  const input = evidence();
  for (const [id, question] of [["Q1", "왜 내려가?"], ["Q2", "왜 오르는 거야?"]]) {
    input.questions.add(question);
    input.questionSources.set(question, { id, label: "내 질문", startMs: 80_000 });
  }
  const qa = { type: "qa", label: "가격이 변하는 이유는?", text: "근거로 확인한 답", sourceIds: ["T1"] };
  for (const questionIds of [[], undefined]) {
    assert.throws(() => validateLectureNote(raw([{ ...qa, questionIds }]), input), /missing question IDs/);
  }
  for (const questionIds of [["Q1", "Q999"], ["Q1", ""], ["Q1", 2], [" Q1", "Q2"]]) {
    assert.throws(() => validateLectureNote(raw([{ ...qa, questionIds }]), input), /invented student question/);
  }
  assert.throws(() => validateLectureNote(raw([{ ...qa, questionIds: ["Q1", "Q1", "Q2"] }]), input), /student question repeated/);
  assert.throws(() => validateLectureNote(raw([{ ...qa, questionIds: ["Q1", "Q2"] }, { ...qa, questionIds: ["Q2"] }]), input), /student question repeated/);
  assert.throws(() => validateLectureNote(raw([{ ...qa, questionIds: ["Q1"] }]), input), /student question omitted/);
});

test("question generation schema uses short labels and source IDs rather than model-written original question records", () => {
  for (const english of [false, true]) {
    const qa = noteSchema(english).properties.sections.items.properties.blocks.items.anyOf.find(block => block.properties.type.enum.includes("qa"))!;
    const properties = qa.properties as Record<string, Record<string, unknown>>;
    assert.equal(properties.label.maxLength, english ? 100 : 60);
    assert.equal(properties.questionIds.minItems, 1);
    assert.ok(qa.required.includes("questionIds"));
    assert.ok(!("originalQuestions" in properties), "the server resolves originals without spending output tokens or trusting model rewrites");
    assert.ok(!("originalAnswers" in properties), "only the server may attach saved answers");
    const prompt = notePrompt(english);
    assert.ok(prompt.includes(english ? "same".toUpperCase() : "같은 의도"));
    assert.ok(prompt.includes(english ? "exactly once" : "정확히 한 번"));
    assert.ok(prompt.includes(english ? "one-line takeaway" : "한 줄 요약"));
  }
});

test("saved practice and chart answers remain verbatim even when the model rewrites the answer or forges originals", () => {
  const input = evidence();
  const question = "다른 숫자로 연습문제 줘";
  const answer = "### 확인 질문\n20명은 80점, 10명은 50점. 전체 평균은?\n\n### 정답\n70점. (20 × 80 + 10 × 50) ÷ 30 = 70.";
  input.questions.add(question);
  input.questionSources.set(question, { id: "Q1", label: "내 질문", startMs: 80_000 });
  input.answers = new Map([["Q1", [{ id: "saved-1", questionId: "Q1", text: answer }]]]);
  const result = validateLectureNote(raw([{ type: "qa", label: "새 숫자로 평균 구하기", questionIds: ["Q1"], text: "강의에 다른 예제가 없어 75점 예제로 대신합니다.", sourceIds: [],
    originalAnswers: [{ id: "forged", questionId: "Q1", text: "정답은 75점" }],
  }]), input);
  const block = result.sections[0].blocks[0];
  assert.deepEqual(block.originalAnswers, input.answers.get("Q1"));
  assert.equal(block.label, "새 숫자로 평균 구하기");
  assert.equal(block.text, "");
  assert.deepEqual(block.sourceIds, []);
  assert.deepEqual(block.sources?.map(source => source.id), ["Q1"]);
});

test("questions without saved answers still require lecture evidence, and cannot merge into an answer replay", () => {
  const input = evidence();
  for (const [id, question] of [["Q1", "다른 문제 줘"], ["Q2", "왜 그런가요?"]]) {
    input.questions.add(question);
    input.questionSources.set(question, { id, label: "내 질문", startMs: 80_000 });
  }
  input.answers = new Map([["Q1", [{ id: "saved-1", questionId: "Q1", text: "20명은 80점, 10명은 50점. 정답 70점" }]]]);
  const qa = { type: "qa", label: "설명", text: "설명", sourceIds: [] };
  assert.throws(() => validateLectureNote(raw([{ ...qa, questionIds: ["Q1", "Q2"] }]), input), /answered and unanswered questions grouped/);
  assert.throws(() => validateLectureNote(raw([{ ...qa, questionIds: ["Q1"] }, { ...qa, questionIds: ["Q2"] }]), input), /missing note evidence/);
  assert.throws(() => validateLectureNote(raw([{ ...qa, questionIds: ["Q1"] }, { ...qa, questionIds: ["Q2"], sourceIds: ["saved-1"] }]), input), /unknown note evidence/);
});

test("rejects nonexistent sources and prevents question IDs from becoming factual sources", () => {
  assert.throws(() => validateLectureNote(raw([{ ...paragraph, sourceIds: ["T999"] }]), evidence()), /unknown note evidence/);
  assert.throws(() => validateLectureNote(raw([{ ...paragraph, sourceIds: [] }]), evidence()), /missing note evidence/);
  assert.throws(() => validateLectureNote(raw([{ ...paragraph, sourceIds: ["Q1"] }]), evidence()), /unknown note evidence/);
});

test("material identity follows verified source IDs even when filenames are duplicated", () => {
  const result = validateLectureNote(raw([{ type: "material", label: "slides.pdf", page: 2, text: "설명", sourceIds: ["M2P2"], documentId: "document-1" }]), evidence());
  assert.equal(result.sections[0].blocks[0].documentId, "document-2");
  assert.throws(() => validateLectureNote(raw([{ type: "material", label: "slides.pdf", page: 1, text: "설명", sourceIds: ["M1P2"] }]), evidence()), /does not match evidence/);
  const withoutPreview = evidence();
  withoutPreview.documents[0].storage_path = null;
  assert.throws(() => validateLectureNote(raw([{ type: "material", label: "slides.pdf", page: 2, text: "설명", sourceIds: ["M1P2"] }]), withoutPreview), /does not match evidence/);
});

test("concept times come from actual cited speech, and material-only definitions are not promoted to lecture memory", () => {
  const result = validateLectureNote(raw([paragraph], [
    { name: "미분", definition: "순간 변화율", evidenceClock: "99:99", sourceIds: ["T1"], related: ["적분", "없는 용어", "미분"] },
    { name: "적분", definition: "누적량", evidenceClock: "", sourceIds: ["T1"], related: [] },
    { name: "자료에만 있는 말", definition: "설명", evidenceClock: "00:01", sourceIds: ["M1P2"], related: [] },
  ]), evidence());
  assert.equal(result.concepts?.[0].evidenceClock, "00:01");
  assert.equal(result.concepts?.[0].sources?.[0].startMs, 65_000);
  assert.deepEqual(result.concepts?.[0].related, ["적분"]);
  assert.equal(result.concepts?.length, 2);
});

test("rejects malformed learning components and removes identical repeated blocks", () => {
  assert.throws(() => validateLectureNote(raw([{ type: "table", text: "", columns: ["a", "b"], rows: [["one cell"]], sourceIds: ["T1"] }]), evidence()), /uneven table/);
  assert.throws(() => validateLectureNote(raw([{ type: "steps", entries: [], sourceIds: ["T1"] }]), evidence()), /empty list/);
  assert.throws(() => validateLectureNote(raw([{ type: "formula", latex: "\\frac{", text: "설명", sourceIds: ["T1"] }]), evidence()));
  assert.throws(() => validateLectureNote(raw([{ type: "diagram", mermaid: "sequenceDiagram", text: "설명", sourceIds: ["T1"] }]), evidence()), /unsupported diagram/);
  const result = validateLectureNote(raw([paragraph, paragraph]), evidence());
  assert.equal(result.sections[0].blocks.length, 1);
});


test("generated diagrams reject external resources before they can become saved notes", () => {
  assert.throws(() => validateLectureNote(raw([{ type: "diagram", mermaid: 'flowchart TD\nA@{ img: "https://diagram-audit.invalid/pixel.svg" }', text: "설명", sourceIds: ["T1"] }]), evidence()), /unsupported diagram/);
  const result = validateLectureNote(raw([{ type: "diagram", mermaid: 'flowchart TD\nA[원인] --> B[결과]', text: "설명", sourceIds: ["T1"] }]), evidence());
  assert.equal(result.sections[0].blocks[0].mermaid, 'flowchart TD\nA["원인"] --> B["결과"]');
});
