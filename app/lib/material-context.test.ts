import assert from "node:assert/strict";
import test from "node:test";
import { buildMaterialContext, materialSearchTerms, type MaterialContextChunk, type MaterialContextDocument } from "./material-context.ts";

const document = (id = "doc", indexComplete = true): MaterialContextDocument => ({ id, filename: `${id}.pdf`, indexComplete });
const chunk = (page: number, text: string, documentId = "doc", extra: Partial<MaterialContextChunk> = {}): MaterialContextChunk => ({
  id: `${documentId}-${page}`, documentId, startPage: page, endPage: page, text, ...extra,
});

test("short complete indexes include page7 for a generic question without embeddings", () => {
  const chunks = Array.from({ length: 7 }, (_, index) => chunk(index + 1, `PAGE${index + 1} 내용`));
  const result = buildMaterialContext({ documents: [document()], chunks, question: "어떤 자료인지 알려줘", anchor: "" });
  assert.ok(result.text.includes("PAGE7 내용"));
  assert.ok(result.text.includes("All stored indexed text included."));
  assert.equal(result.sources.length, 7);
  assert.ok(result.text.includes("PDF visuals have not been inspected"));
});

test("Korean particles expose known lexical terms and DB terms contain no filter syntax", () => {
  assert.deepEqual(materialSearchTerms("주식은? 쉽게 설명해줘"), ["주식"]);
  const terms = materialSearchTerms("주식은? %_,()'\"채권의 OR (id.eq.secret) " + Array.from({ length: 20 }, (_, index) => `term${index}`).join(" "));
  assert.ok(terms.includes("주식"));
  assert.ok(terms.includes("채권"));
  assert.ok(terms.length <= 12);
  assert.ok(terms.every((term) => /^[\p{L}\p{N}]+$/u.test(term)));
});

test("a question topic on page7 survives cover pages without embeddings", () => {
  const result = buildMaterialContext({
    documents: [document("doc", false)],
    chunks: [chunk(1, "표지 소개 ".repeat(1_000)), chunk(7, "주식은 기업의 소유권을 나눈 증권입니다.")],
    question: "주식은?", anchor: "", maxCharacters: 1_000,
  });
  assert.ok(result.text.includes("주식은 기업의 소유권"));
  assert.ok(result.sources.some((source) => source.startPage === 7));
  assert.ok(result.text.length <= 1_000);
});

test("late lexical candidates beyond a loaded prefix outrank unrelated prefix text", () => {
  const result = buildMaterialContext({
    documents: [document("doc", false)],
    chunks: [...Array.from({ length: 36 }, (_, index) => chunk(index + 1, "prefix overview ".repeat(500))), chunk(90, "전환사채는 채권을 주식으로 전환할 수 있는 권리가 있습니다.")],
    question: "전환사채는?", anchor: "", maxCharacters: 2_000,
  });
  assert.ok(result.text.includes("전환사채는 채권"));
  assert.ok(result.sources.some((source) => source.startPage === 90));
  assert.ok(result.text.includes("Index read incomplete"));
});

test("vague questions use anchor terms and preserve a neighboring candidate", () => {
  const result = buildMaterialContext({
    documents: [document("doc", false)],
    chunks: [chunk(1, "무관한 자료 ".repeat(1_000)), chunk(6, "PREVIOUS_PAGE"), chunk(7, "주식은 소유권을 나타냅니다."), chunk(8, "NEXT_PAGE")],
    question: "이게 뭐예요?", anchor: "주식 소유권", maxCharacters: 1_000,
  });
  assert.ok(result.text.includes("주식은 소유권"));
  assert.ok(result.text.includes("PREVIOUS_PAGE"));
  assert.ok(result.text.includes("NEXT_PAGE"));
});

test("semantic and anchor candidates work when no lexical term matches", () => {
  for (const score of ["semanticScore", "anchorScore"] as const) {
    const result = buildMaterialContext({ documents: [document("doc", false)], chunks: [chunk(1, "cover ".repeat(1_000)), chunk(7, "RELEVANT_CONTENT", "doc", { [score]: 0.9 })], question: "설명해줘", anchor: "", maxCharacters: 700 });
    assert.ok(result.text.includes("RELEVANT_CONTENT"), score);
  }
});

test("twenty cover pages cannot starve a relevant question chunk in the last document", () => {
  const documents = Array.from({ length: 20 }, (_, index) => document(`doc${index}`, false));
  const chunks = documents.map((doc) => chunk(1, "cover overview ".repeat(500), doc.id));
  chunks.push(chunk(7, "주식은 소유권입니다.", "doc19"));
  const result = buildMaterialContext({ documents, chunks, question: "주식은?", anchor: "", maxCharacters: 6_000 });
  assert.ok(result.text.includes("주식은 소유권"));
  for (const doc of documents) assert.ok(result.text.includes(doc.filename), doc.filename);
  assert.ok(result.text.length <= 6_000);
});

test("all headers, status notices and excerpts share the same tight budget", () => {
  const documents = Array.from({ length: 20 }, (_, index) => ({ ...document(`doc${index}`, false), filename: `${"long filename ".repeat(20)}${index}.pdf` }));
  const chunks = documents.map((doc, index) => chunk(1, index === 19 ? "주식은 소유권입니다." : "cover ".repeat(800), doc.id));
  const result = buildMaterialContext({ documents, chunks, question: "주식은?", anchor: "", maxCharacters: 1_000 });
  assert.ok(result.text.includes("주식은 소유권"));
  assert.ok(result.text.includes("identities were omitted"));
  assert.ok(result.text.length <= 1_000);
  assert.deepEqual(buildMaterialContext({ documents, chunks, question: "", anchor: "", maxCharacters: 0 }), { text: "", sources: [] });
});

test("chunks outside the supplied document set and invalid page fields never enter context", () => {
  const result = buildMaterialContext({ documents: [document()], chunks: [chunk(7, "SAFE"), chunk(1, "SECRET", "foreign"), chunk(0, "INVALID_ZERO"), chunk(Number.NaN, "INVALID_NAN"), chunk(8, "INVALID_REVERSED", "doc", { endPage: 7 })], question: "SECRET", anchor: "" });
  assert.ok(result.text.includes("SAFE"));
  assert.ok(!result.text.includes("SECRET"));
  assert.ok(!result.text.includes("INVALID_"));
  assert.deepEqual(result.sources.map((source) => source.documentId), ["doc"]);
});

test("duplicate retrieval hits appear once, page order is physical, and fragment order is qualified", () => {
  const result = buildMaterialContext({ documents: [document()], chunks: [chunk(7, "FRAGMENT_B", "doc", { id: "b" }), chunk(1, "FIRST"), chunk(7, "FRAGMENT_A", "doc", { id: "a" }), chunk(1, "FIRST", "doc", { semanticScore: 0.8 })], question: "", anchor: "" });
  assert.equal(result.text.match(/FIRST/g)?.length, 1);
  assert.ok(result.text.indexOf("FIRST") < result.text.indexOf("FRAGMENT_"));
  assert.ok(result.text.includes("Same-page fragments have unconfirmed source order"));
  assert.deepEqual(result.sources.map((source) => source.startPage), [1, 7]);
});

test("failed and empty reads make no claim about the original PDF being absent or blank", () => {
  for (const chunks of [[], [chunk(7, "RECOVERED_EXCERPT")]]) {
    const result = buildMaterialContext({ documents: [{ ...document(), indexReadFailed: true }], chunks, question: "", anchor: "" });
    assert.ok(result.text.includes("Stored-text retrieval failed"));
    assert.ok(!result.text.includes("All stored indexed text included"));
  }
  const result = buildMaterialContext({ documents: [document()], chunks: [], question: "", anchor: "" });
  assert.ok(result.text.includes("No stored text retrieved; original content not assessed"));
});

test("nonfinite and excessive RPC scores cannot overpower a concrete lexical question", () => {
  const result = buildMaterialContext({ documents: [document("doc", false)], chunks: [chunk(1, "UNRELATED ".repeat(800), "doc", { semanticScore: Number.POSITIVE_INFINITY, anchorScore: Number.NaN }), chunk(7, "주식은 소유권입니다.")], question: "주식은?", anchor: "", maxCharacters: 650 });
  assert.ok(result.text.includes("주식은 소유권"));
  assert.ok(result.text.length <= 650);
});

test("spare shared budget restores full short-document text after temporary overview clipping", () => {
  const documents = [document("short"), document("large", false)];
  const chunks = [
    ...Array.from({ length: 12 }, (_, index) => chunk(index + 1, `${"short text ".repeat(90)} SHORT_PAGE_${index + 1}_END`, "short")),
    chunk(1, `${"large prefix ".repeat(400)} LARGE_PREFIX_END`, "large"),
  ];
  const result = buildMaterialContext({ documents, chunks, question: "설명해줘", anchor: "" });
  assert.ok(result.text.includes("SHORT_PAGE_1_END"));
  assert.ok(result.text.includes("SHORT_PAGE_12_END"));
  assert.ok(result.text.includes("LARGE_PREFIX_END"));
  assert.ok(result.text.includes('Material "short.pdf"\nIndex status: All stored indexed text included.'));
  assert.ok(result.text.includes('Material "large.pdf"\nIndex status: Index read incomplete; selected excerpts.'));
  assert.ok(result.text.length <= 60_000);
});

test("failed-read status overhead never overflows or erases a tight valid excerpt", () => {
  const documents = [{ ...document("doc", false), indexReadFailed: true }];
  for (const maxCharacters of [300, 350, 400, 450]) {
    const result = buildMaterialContext({ documents, chunks: [chunk(7, "주식 ".repeat(500))], question: "주식은?", anchor: "", maxCharacters });
    assert.ok(result.text.includes("Stored-text retrieval failed"));
    assert.ok(result.text.includes("주식"));
    assert.ok(result.text.length <= maxCharacters);
  }
});
