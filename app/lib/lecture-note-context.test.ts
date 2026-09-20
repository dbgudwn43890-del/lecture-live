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

test("concept generation bounds match accepted counts in both output languages", () => {
  for (const language of ["ko", "en"] as const) {
    const limit = noteSchema(language).properties.concepts.maxItems;
    assert.equal(limit, 15);
    for (const count of [0, 15, 16]) {
      const concepts = Array.from({ length: count }, (_, i) => ({
        name: `개념 ${i + 1}`, definition: "발화에서 정의한 개념", evidenceClock: "", related: [], sourceIds: ["T1"],
      }));
      if (count <= limit) assert.equal(validateLectureNote(raw([paragraph], concepts), evidence()).concepts?.length, count);
      else assert.throws(() => validateLectureNote(raw([paragraph], concepts), evidence()), /too many concepts/);
    }
  }
});

test("table generation bounds match validator boundaries in both output languages", () => {
  for (const language of ["ko", "en"] as const) {
    const variants = noteSchema(language).properties.sections.items.properties.blocks.items.anyOf;
    const table = variants.find(variant => variant.properties.type.enum.includes("table"))!;
    const properties = table.properties as Record<string, unknown>;
    const columnBounds = properties.columns as { minItems: number; maxItems: number };
    const rowBounds = properties.rows as { minItems: number };
    assert.equal(columnBounds.minItems, 2);
    assert.equal(columnBounds.maxItems, 4);
    assert.equal(rowBounds.minItems, 1);
    for (const width of [1, 2, 4, 5]) for (const height of [0, 1]) {
      const columns = Array.from({ length: width }, (_, i) => `열 ${i + 1}`);
      const rows = Array.from({ length: height }, () => columns.map(() => "값"));
      const value = raw([{ type: "table", text: "비교", columns, rows, sourceIds: ["T1"] }]);
      if (width >= columnBounds.minItems && width <= columnBounds.maxItems && height >= rowBounds.minItems) {
        const result = validateLectureNote(value, evidence()).sections[0].blocks[0];
        assert.deepEqual(result.columns, columns);
        assert.deepEqual(result.rows, rows);
      } else assert.throws(() => validateLectureNote(value, evidence()), /invalid table/);
    }
  }
});

test("blank table headers keep their column positions without accepting malformed cells", () => {
  const table = { type: "table", text: "리다이렉션 비교", columns: [" ", " 표준 출력 ", " 표준 오류 "],
    rows: [["파일", " >", "2>"], ["추가", ">>", "2>>"]], sourceIds: ["T1"] };
  const result = validateLectureNote(raw([table]), evidence()).sections[0].blocks[0];
  assert.deepEqual(result.columns, ["", "표준 출력", "표준 오류"]);
  assert.deepEqual(result.rows, [["파일", ">", "2>"], ["추가", ">>", "2>>"]]);
  assert.throws(() => validateLectureNote(raw([{ ...table, rows: [["파일", ">"]] }]), evidence()), /uneven table/);
  assert.throws(() => validateLectureNote(raw([{ ...table, columns: ["", 7, "표준 오류"] }]), evidence()), /invalid table/);
  assert.throws(() => validateLectureNote(raw([{ ...table, rows: [["파일", 7, "2>"]] }]), evidence()), /uneven table/);
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
    assert.ok(prompt.includes(english ? "SAME underlying confusion" : "같은 근본적인 헷갈림"));
    assert.ok(prompt.includes(english ? "exactly once" : "정확히 한 번"));
    assert.ok(prompt.includes(english ? "one-line takeaway" : "한 줄 요약"));
  }
});

test("curated practice explanation keeps server-owned originals and rejects forged originals", () => {
  const input = evidence();
  const question = "다른 숫자로 연습문제 줘";
  const answer = "### 확인 질문\n20명은 80점, 10명은 50점. 전체 평균은?\n\n### 정답\n70점. (20 × 80 + 10 × 50) ÷ 30 = 70.";
  input.questions.add(question);
  input.questionSources.set(question, { id: "Q1", label: "내 질문", startMs: 80_000 });
  input.answers = new Map([["Q1", [{ id: "saved-1", questionId: "Q1", text: answer }]]]);
  const result = validateLectureNote(raw([{ type: "qa", label: "새 숫자로 평균 구하기", questionIds: ["Q1"], text: "20명은 80점, 10명은 50점이면 인원으로 가중한 평균은 70점이다.", sourceIds: [],
    originalAnswers: [{ id: "forged", questionId: "Q1", text: "정답은 75점" }],
  }]), input);
  const block = result.sections[0].blocks[0];
  assert.deepEqual(block.originalAnswers, input.answers.get("Q1"));
  assert.equal(block.label, "새 숫자로 평균 구하기");
  assert.equal(block.text, "20명은 80점, 10명은 50점이면 인원으로 가중한 평균은 70점이다.");
  assert.deepEqual(block.sourceIds, []);
  assert.deepEqual(block.sources?.map(source => source.id), ["Q1"]);
});

test("unanswered follow-ups can merge with answered questions only with lecture evidence", () => {
  const input = evidence();
  for (const [id, question] of [["Q1", "다른 문제 줘"], ["Q2", "왜 그런가요?"]]) {
    input.questions.add(question);
    input.questionSources.set(question, { id, label: "내 질문", startMs: 80_000 });
  }
  input.answers = new Map([["Q1", [{ id: "saved-1", questionId: "Q1", text: "20명은 80점, 10명은 50점. 정답 70점" }]]]);
  const qa = { type: "qa", label: "설명", text: "설명", sourceIds: [] };
  assert.throws(() => validateLectureNote(raw([{ ...qa, questionIds: ["Q1", "Q2"] }]), input), /missing note evidence/);
  const grouped = validateLectureNote(raw([{ ...qa, questionIds: ["Q1", "Q2"], sourceIds: ["T1"] }]), input);
  assert.equal(grouped.sections[0].blocks[0].originalQuestions?.length, 2);
  assert.equal(grouped.sections[0].blocks[0].originalAnswers?.length, 1);
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
  assert.throws(() => validateLectureNote(raw([{ type: "formula", latex: "\\frac{", text: "설명", sourceIds: ["T1"] }]), evidence()), { message: "invalid note formula" });
  const result = validateLectureNote(raw([paragraph, paragraph]), evidence());
  assert.equal(result.sections[0].blocks.length, 1);
});


test("valid diagrams keep their canonical syntax and do not report a recovery", () => {
  const recoveries: string[] = [];
  const result = validateLectureNote(raw([{ type: "diagram", mermaid: 'flowchart TD\nA[원인] --> B[결과]', text: "설명", sourceIds: ["T1"] }]), evidence(), reason => recoveries.push(reason));
  assert.equal(result.sections[0].blocks[0].type, "diagram");
  assert.equal(result.sections[0].blocks[0].mermaid, 'flowchart TD\nA["원인"] --> B["결과"]');
  assert.deepEqual(recoveries, []);
});

test("unsupported or unsafe diagram syntax keeps the grounded caption without losing the rest of the note", () => {
  for (const mermaid of [
    "flowchart LR\nA --> B", "graph TD\nA --> B", "flowchart TD;\nA --> B",
    "flowchart TD\nA --> B; B --> C;", "sequenceDiagram\nA->>B: hello", "",
    'flowchart TD\nA@{ img: "https://diagram-audit.invalid/pixel.svg" }',
    'flowchart TD\n%%{init: {securityLevel: "loose"}}%%\nA --> B',
  ]) {
    const input = evidence();
    const recoveries: string[] = [];
    const result = validateLectureNote(raw([
      paragraph,
      { type: "diagram", mermaid, text: "입력이 처리 과정을 거쳐 출력으로 이어진다.", sourceIds: ["T1", "M1P2"] },
    ]), input, reason => recoveries.push(reason));
    assert.equal(result.sections[0].blocks.length, 2);
    assert.equal(result.sections[0].blocks[0].text, paragraph.text);
    const recovered = result.sections[0].blocks[1];
    assert.equal(recovered.type, "paragraph");
    assert.equal(recovered.text, "입력이 처리 과정을 거쳐 출력으로 이어진다.");
    assert.equal(recovered.mermaid, "");
    assert.deepEqual(recovered.sourceIds, ["T1", "M1P2"]);
    assert.deepEqual(recovered.sources, [input.sources.get("T1"), input.sources.get("M1P2")]);
    assert.notEqual(recovered.sources![0], input.sources.get("T1"));
    if (mermaid) assert.ok(!JSON.stringify(result).includes(JSON.stringify(mermaid).slice(1, -1)), "rejected syntax never persists");
    assert.deepEqual(recoveries, ["diagram_text_fallback"], "telemetry contains only a fixed recovery code");
  }
});

test("diagram recovery never bypasses source, caption, field-type, or question coverage validation", () => {
  const diagram = { type: "diagram", mermaid: "flowchart LR\nA --> B", text: "근거에 있는 입력과 출력의 관계", sourceIds: ["T1"] };
  for (const invalid of [
    { sourceIds: [] }, { sourceIds: ["T999"] }, { sourceIds: ["Q1"] },
    { text: " \n\t" }, { text: undefined }, { mermaid: null }, { mermaid: 123 },
  ]) {
    const recoveries: string[] = [];
    assert.throws(() => validateLectureNote(raw([paragraph, { ...diagram, ...invalid }]), evidence(), reason => recoveries.push(reason)), /missing note evidence|unknown note evidence|invalid note text/);
    assert.deepEqual(recoveries, [], "invalid grounding or required fields cannot be recovered");
  }
  const input = evidence();
  input.questionTurns = new Map([["Q1", { text: "pipe가 뭐야?", source: { id: "Q1", label: "내 질문" } }]]);
  assert.throws(() => validateLectureNote(raw([paragraph, diagram]), input), /student question omitted/);
});


test("curation accounts for excluded chatter without displaying it or silently dropping learning questions", () => {
  const input = evidence();
  for (const [id, question] of [["Q1", "미분이 뭐야?"], ["Q2", "아 뭔 소리야 더 쉽게"], ["Q3", "ㅋㅋ 고마워"]]) {
    input.questions.add(question);
    input.questionSources.set(question, { id, label: "내 질문", startMs: 80_000 });
  }
  const blocks = [{ type: "qa", label: "미분을 순간 변화율로 이해하는 방법은?", text: "미분은 한 순간의 변화율이다.", questionIds: ["Q1", "Q2"], sourceIds: ["T1"] }];
  const payload = { ...raw(blocks), excludedQuestions: [{ questionId: "Q3", reason: "non_learning" }] };
  const note = validateLectureNote(payload, input);
  assert.equal(note.sections[0].blocks.length, 1);
  assert.equal(note.sections[0].blocks[0].originalQuestions?.length, 2);
  assert.doesNotMatch(JSON.stringify(note), /ㅋㅋ 고마워/);
  assert.throws(() => validateLectureNote(raw(blocks), input), /student question omitted/);
  for (const excludedQuestions of [
    [{ questionId: "Q999", reason: "non_learning" }],
    [{ questionId: "Q1", reason: "non_learning" }],
    [{ questionId: "Q3", reason: "non_learning" }, { questionId: "Q3", reason: "off_topic" }],
    [{ questionId: "Q3", reason: "too_short" }],
    [{ questionId: "Q3", reason: ["non_learning"] }],
  ]) assert.throws(() => validateLectureNote({ ...payload, excludedQuestions }, input), /invented|repeated|exclusion reason/);
  assert.throws(() => validateLectureNote({ ...payload, sections: [{ heading: "개념", blocks: [{ ...blocks[0], text: "" }] }] }, input), /invalid note text/);
});

test("a lecture containing only non-learning conversation produces no forced QA block", () => {
  const input = evidence();
  input.questions.add("testing hello");
  input.questionSources.set("testing hello", { id: "Q1", label: "내 질문" });
  const note = validateLectureNote({ ...raw([paragraph]), excludedQuestions: [{ questionId: "Q1", reason: "non_learning" }] }, input);
  assert.deepEqual(note.sections[0].blocks.map(block => block.type), ["paragraph"]);
});

test("generic lecture-status turns cannot become rewritten learning questions even with saved answers", () => {
  for (const question of ["여기까지 요약", "지금까지 뭐라고 했어?", "내가 마지막으로 질문한 이후 뭐라고 했어?", "What did I miss?"]) {
    const input = evidence();
    input.questionTurns = new Map([["Q1", { text: question, source: { id: "Q1", label: "내 질문", startMs: 80_000 } }]]);
    input.answers = new Map([["Q1", [{ id: "saved-status", questionId: "Q1", text: "강의 전체를 길게 요약한 기존 답변" }]]]);
    const qa = { type: "qa", label: "파이프는 어떤 용도로 사용하는가?", questionIds: ["Q1"], text: "모델이 학습 질문으로 바꾼 내용", sourceIds: ["T1"] };
    assert.throws(() => validateLectureNote(raw([qa]), input), /lecture status request/, question);
    const note = validateLectureNote({ ...raw([paragraph]), excludedQuestions: [{ questionId: "Q1", reason: "status_check" }] }, input);
    assert.deepEqual(note.sections[0].blocks.map(block => block.type), ["paragraph"]);
    assert.doesNotMatch(JSON.stringify(note), /saved-status|길게 요약한 기존 답변/);
    assert.throws(() => validateLectureNote(raw([paragraph]), input), /student question omitted/);
  }
});

test("status exclusions keep each turn accountable while preserving specific and mixed learning requests", () => {
  const input = evidence();
  input.questionTurns = new Map([
    ["Q1", { text: "여기까지 요약", source: { id: "Q1", label: "내 질문" } }],
    ["Q2", { text: "pipe가 뭐야?", source: { id: "Q2", label: "내 질문" } }],
    ["Q3", { text: "다시 설명해줘", source: { id: "Q3", label: "내 질문" } }],
    ["Q4", { text: "여기까지 요약하고 파이프가 왜 필요한지 설명", source: { id: "Q4", label: "내 질문" } }],
  ]);
  const qa = { type: "qa", label: "파이프의 역할은 무엇인가?", questionIds: ["Q2", "Q3", "Q4"], text: "파이프는 프로세스 사이에서 데이터를 전달한다.", sourceIds: ["T1"] };
  const payload = { ...raw([qa]), excludedQuestions: [{ questionId: "Q1", reason: "status_check" }] };
  const note = validateLectureNote(payload, input);
  assert.deepEqual(note.sections[0].blocks[0].originalQuestions?.map(question => question.id), ["Q2", "Q3", "Q4"]);
  assert.throws(() => validateLectureNote({ ...payload, excludedQuestions: [...payload.excludedQuestions, ...payload.excludedQuestions] }, input), /student question repeated/);
  assert.throws(() => validateLectureNote({ ...payload, excludedQuestions: [{ questionId: "Q999", reason: "status_check" }] }, input), /invented student question/);
  assert.throws(() => validateLectureNote({ ...payload, excludedQuestions: [...payload.excludedQuestions, { questionId: "Q2", reason: "status_check" }] }, input), /student question repeated/);
  for (const reason of ["non_learning", "off_topic", "uninterpretable"]) {
    assert.doesNotThrow(() => validateLectureNote({ ...payload, excludedQuestions: [{ questionId: "Q1", reason }] }, input));
  }
});

test("code blocks preserve indentation, blank lines, and final newlines exactly", () => {
  const code = "\nif ready:\n\tprint('pipe')  \n\n    # intentional indentation\n";
  const block = { type: "code", code, language: "python", text: "준비된 경우에만 출력한다.", sourceIds: ["T1"] };
  const note = validateLectureNote(raw([block]), evidence());
  assert.equal(note.sections[0].blocks[0].code, code);
  assert.equal(note.sections[0].blocks[0].language, "python");
  assert.equal(note.sections[0].blocks[0].text, block.text);
  assert.deepEqual(note.sections[0].blocks[0].sourceIds, ["T1"]);
  assert.equal(validateLectureNote(raw([{ ...block, language: "" }]), evidence()).sections[0].blocks[0].language, "");
  for (const invalid of [
    { code: " \n\t " }, { code: 123 }, { code: undefined }, { language: "x".repeat(33) },
    { language: "js\nhtml" }, { language: "python\u0000" }, { language: 123 }, { language: undefined },
    { text: " " }, { sourceIds: [] }, { sourceIds: ["Q1"] },
  ]) assert.throws(() => validateLectureNote(raw([{ ...block, ...invalid }]), evidence()));
});

test("check blocks reject placeholder headings instead of moving a hidden question out of the solution", () => {
  const answerOnly = "pipe의 읽기 끝은 어느 파일 디스크립터인가?\n정답은 fd[0]이다.";
  for (const label of ["", " ", "문제", "문제 1", "1. 확인 질문", "이해 확인", "연습문제", "Question", "QUESTION 2:", "Check your understanding", "Check yourself", "Exercise"]) {
    assert.throws(() => validateLectureNote(raw([{ type: "check", label, hint: "", text: answerOnly, sourceIds: ["T1"] }]), evidence()), /invalid note text|missing check question/, label);
  }
  for (const label of ["pipe의 읽기 끝은 어느 파일 디스크립터인가?", "문제: fd[0]과 fd[1]의 역할을 설명하시오.", "f(x)=x²의 도함수를 구하시오.", "What is the role of fd[0]?"]) {
    const note = validateLectureNote(raw([{ type: "check", label, hint: "", text: "fd[0]은 읽기 끝이다.", sourceIds: ["T1"] }]), evidence());
    assert.equal(note.sections[0].blocks[0].label, label);
    assert.equal(note.sections[0].blocks[0].text, "fd[0]은 읽기 끝이다.");
  }
});
