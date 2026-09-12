import katex from "katex";
import { safeNoteDiagram } from "./mermaid-safety.ts";
import type { LectureNote, NoteAnswer, NoteBlock, NoteConcept, NoteSource } from "./lecture-note";

export class NoteInputError extends Error {
  readonly kind: "transcript" | "materials" | "questions" | "read";
  constructor(kind: NoteInputError["kind"]) { super(kind); this.kind = kind; }
}

export type NoteDocument = { id: string; filename: string; page_count: number | null; storage_path: string | null };
export type NoteEvidence = {
  sources: Map<string, NoteSource>;
  questions: Set<string>;
  questionSources: Map<string, NoteSource>;
  /** Conversation history is preserved separately, never promoted to lecture evidence. */
  answers?: Map<string, NoteAnswer[]>;
  documents: NoteDocument[];
};

export function noteClock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function noteInputMessage(kind: NoteInputError["kind"], english: boolean) {
  const messages = {
    transcript: ["수업 전체를 빠짐없이 담기에는 스크립트가 너무 깁니다. 강의를 짧은 수업으로 나누어 노트를 만들어 주세요. 앞부분만으로 노트를 만들지는 않았습니다.", "The complete transcript is too long for one note. Split the lecture into shorter sessions. No partial note was created."],
    materials: ["연결된 자료가 너무 많아 전체를 읽을 수 없습니다. 이번 수업에서 사용한 자료만 연결한 뒤 다시 시도해 주세요. 기존 노트는 유지됩니다.", "The attached materials are too large to read completely. Keep only the materials used in this lecture and try again. Your existing note is kept."],
    questions: ["이 수업의 질문과 답변이 한 번에 처리할 수 있는 분량을 넘었습니다. 수업을 나누어 다시 시도해 주세요. 대화 일부를 빼고 노트를 만들지는 않았습니다.", "This lecture has too much question and answer history for one note. Split it into shorter sessions. No conversation was silently omitted."],
    read: ["수업 자료를 끝까지 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. 기존 노트는 유지됩니다.", "Could not load the complete lecture context. Please try again shortly. Your existing note is kept."],
  };
  return messages[kind][english ? 1 : 0];
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid note object");
  return value as Record<string, unknown>;
};
const text = (value: unknown, required = false) => {
  if (typeof value !== "string" || (required && !value.trim())) throw new Error("invalid note text");
  return value.trim();
};
const strings = (value: unknown) => {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error("invalid note list");
  return value.map(item => item.trim()).filter(Boolean) as string[];
};

/** Resolve only IDs supplied with this input, never model-authored locations. */
function references(value: unknown, evidence: NoteEvidence): NoteSource[] {
  const ids = [...new Set(strings(value))];
  if (!ids.length) throw new Error("missing note evidence");
  return ids.map(id => {
    const source = evidence.sources.get(id);
    if (!source) throw new Error("unknown note evidence");
    return { ...source };
  });
}

/** Structured output checks shape; these checks enforce source and UI semantics. */
export function validateLectureNote(value: unknown, evidence: NoteEvidence): LectureNote {
  const raw = object(value);
  if (!Array.isArray(raw.sections) || !raw.sections.length) throw new Error("empty note");
  const originalQuestions = new Map<string, { text: string; source: NoteSource }>();
  for (const question of evidence.questions) {
    const source = evidence.questionSources.get(question);
    if (!source || !/^Q[1-9][0-9]*$/.test(source.id)) throw new Error("missing question provenance");
    if (originalQuestions.has(source.id)) throw new Error("ambiguous question provenance");
    originalQuestions.set(source.id, { text: question, source });
  }
  const seenBlocks = new Set<string>();
  const seenQuestions = new Set<string>();
  let checks = 0;
  const sections = raw.sections.map(sectionValue => {
    const section = object(sectionValue);
    if (!Array.isArray(section.blocks)) throw new Error("invalid section");
    const blocks: NoteBlock[] = [];
    for (const blockValue of section.blocks) {
      const block = object(blockValue);
      // A replayed answer has conversation provenance, not fabricated T/M evidence.
      const sources = block.type === "qa" && !strings(block.sourceIds).length ? [] : references(block.sourceIds, evidence);
      const normalized: NoteBlock = {
        type: block.type as NoteBlock["type"], text: "", items: [], latex: "", mermaid: "", label: "", page: 0,
        sourceIds: sources.map(source => source.id), sources,
      };
      switch (block.type) {
        case "paragraph": normalized.text = text(block.text, true); break;
        case "list":
        case "steps": {
          if (!Array.isArray(block.entries) || !block.entries.length) throw new Error("empty list");
          normalized.entries = block.entries.map(entryValue => {
            const entry = object(entryValue);
            return { text: text(entry.text, true), children: strings(entry.children) };
          });
          normalized.items = normalized.entries.map(entry => entry.text);
          break;
        }
        case "table": {
          normalized.text = text(block.text);
          normalized.columns = strings(block.columns);
          if (normalized.columns.length < 2 || normalized.columns.length > 4 || !Array.isArray(block.rows) || !block.rows.length) throw new Error("invalid table");
          normalized.rows = block.rows.map(row => {
            // Empty cells are valid; do not filter them and shift columns.
            if (!Array.isArray(row) || row.length !== normalized.columns!.length || !row.every(cell => typeof cell === "string")) throw new Error("uneven table");
            return row.map(cell => cell.trim());
          });
          break;
        }
        case "qa": {
          normalized.label = text(block.label, true);
          if (!Array.isArray(block.questionIds) || !block.questionIds.length) throw new Error("missing question IDs");
          normalized.questionIds = [];
          normalized.originalQuestions = [];
          const answers: NoteAnswer[] = [];
          let unanswered = 0;
          for (const id of block.questionIds) {
            const original = typeof id === "string" ? originalQuestions.get(id) : undefined;
            if (!original) throw new Error("invented student question");
            if (seenQuestions.has(id)) throw new Error("student question repeated");
            seenQuestions.add(id);
            normalized.questionIds.push(id);
            normalized.originalQuestions.push({ id, text: original.text });
            normalized.sources!.push({ ...original.source });
            const saved = evidence.answers?.get(id) ?? [];
            if (!saved.length) unanswered++;
            answers.push(...saved.map(answer => ({ ...answer })));
          }
          if (answers.length) {
            if (unanswered) throw new Error("answered and unanswered questions grouped");
            normalized.originalAnswers = answers;
            // The model may still re-answer using the lecture's 75-point example.
            // Never display that replacement beside the original 70-point practice.
            normalized.text = "";
            normalized.sourceIds = [];
            normalized.sources = normalized.sources!.filter(source => /^Q[1-9][0-9]*$/.test(source.id));
          } else {
            if (!normalized.sourceIds!.length) throw new Error("missing note evidence");
            normalized.text = text(block.text, true);
          }
          break;
        }
        case "check":
          if (++checks > 3) throw new Error("too many checks");
          normalized.hint = text(block.hint);
          normalized.label = text(block.label, true);
          normalized.text = text(block.text, true);
          break;
        case "callout":
          normalized.label = text(block.label, true);
          normalized.text = text(block.text, true);
          break;
        case "formula":
          normalized.latex = text(block.latex, true);
          normalized.text = text(block.text, true);
          katex.renderToString(normalized.latex, { throwOnError: true, trust: false, strict: "ignore" });
          break;
        case "diagram":
          normalized.mermaid = safeNoteDiagram(text(block.mermaid, true)) ?? "";
          if (!normalized.mermaid) throw new Error("unsupported diagram");
          normalized.text = text(block.text, true);
          break;
        case "material": {
          normalized.label = text(block.label, true);
          normalized.text = text(block.text, true);
          if (!Number.isInteger(block.page) || Number(block.page) < 1) throw new Error("invalid material page");
          normalized.page = Number(block.page);
          // Same filename can exist twice: the validated source ID disambiguates.
          const source = sources.find(item => item.page === normalized.page && evidence.documents.some(document => document.id === item.documentId && document.filename === normalized.label && document.storage_path));
          if (!source) throw new Error("material does not match evidence");
          normalized.documentId = source.documentId;
          break;
        }
        default: throw new Error("unsupported note block");
      }
      const fingerprint = JSON.stringify({ ...normalized, sources: undefined, sourceIds: undefined });
      if (seenBlocks.has(fingerprint)) continue;
      seenBlocks.add(fingerprint);
      blocks.push(normalized);
    }
    return { heading: text(section.heading, true), blocks };
  }).filter(section => section.blocks.length);
  if (!sections.length) throw new Error("empty note");
  if ([...originalQuestions.keys()].some(id => !seenQuestions.has(id))) throw new Error("student question omitted");

  if (!Array.isArray(raw.concepts)) throw new Error("invalid concepts");
  const seenConcepts = new Set<string>();
  const concepts: NoteConcept[] = [];
  for (const value of raw.concepts) {
    const concept = object(value);
    const name = text(concept.name, true);
    const sources = references(concept.sourceIds, evidence);
    // A material-only description must not become a remembered lecturer definition.
    const spoken = sources.find(source => source.startMs !== undefined);
    if (!spoken || seenConcepts.has(name)) continue;
    seenConcepts.add(name);
    const minutes = Math.floor(spoken.startMs! / 60_000);
    concepts.push({ name, definition: text(concept.definition, true), related: strings(concept.related), sourceIds: sources.map(source => source.id), sources,
      evidenceClock: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` });
  }
  if (concepts.length > 15) throw new Error("too many concepts");
  for (const concept of concepts) concept.related = [...new Set(concept.related)].filter(name => seenConcepts.has(name) && name !== concept.name);
  const keyPoints = [...new Set(strings(raw.keyPoints))];
  // New generations are bounded by NOTE_SCHEMA. Preserve older/exceptional
  // text verbatim here: clipping a number, condition or negation changes facts.
  // The reader can fold long/extra items without failing an otherwise good note.
  return { title: text(raw.title, true), summary: text(raw.summary, true), keyPoints, sections, concepts };
}
