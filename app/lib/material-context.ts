export type MaterialContextDocument = {
  id: string;
  filename: string;
  indexComplete: boolean;
  indexReadFailed?: boolean;
};
export type MaterialContextChunk = {
  id: string;
  documentId: string;
  startPage: number;
  endPage: number;
  text: string;
  semanticScore?: number;
  anchorScore?: number;
};

export const MAX_MATERIAL_CONTEXT_CHARACTERS = 60_000;
const STOPWORDS = new Set([
  "어떤", "무슨", "무엇", "무엇인가요", "뭔가요", "뭐예요", "이것", "이거", "이게", "그것", "그거", "저것", "여기", "지금", "방금",
  "자료", "강의", "수업", "내용", "설명", "질문", "답변", "정리", "요약", "핵심", "알려", "주세요", "해줘", "다시", "쉽게", "자세히", "좀",
  "the", "and", "what", "which", "why", "how", "this", "that", "these", "those", "about", "please", "explain", "describe", "summarize",
  "material", "materials", "document", "documents", "lecture", "slides", "slide", "page", "pages", "does", "mean", "can", "you", "is", "are", "of", "in", "on", "to", "it", "a", "an",
]);
const PARTICLES = ["으로부터", "에서는", "이라는", "이라면", "으로", "에서", "에게", "까지", "부터", "보다", "처럼", "이란", "이랑", "하고", "은", "는", "이", "가", "을", "를", "의", "에", "도", "만", "와", "과", "로"];

/** Safe literal terms for DB ilike filters, with a small Korean particle pass. */
export function materialSearchTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const raw of question.normalize("NFKC").toLowerCase().slice(0, 8_000).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    let word = raw.replace(/(?:설명해주세요|설명해줘|알려주세요|알려줘|무엇인가요|뭔가요|뭐예요|인가요)$/u, "");
    for (const suffix of PARTICLES) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 2) { word = word.slice(0, -suffix.length); break; }
    }
    if (word.length < 2 || word.length > 40 || /^\p{N}+$/u.test(word) || STOPWORDS.has(word)) continue;
    terms.add(word);
    if (terms.size === 12) break;
  }
  return [...terms];
}

type Source = { documentId: string; filename: string; startPage: number; endPage: number };
type Excerpt = { chunk: MaterialContextChunk; text: string; truncated: boolean };
const INTRO = "Indexed text evidence only; PDF visuals have not been inspected. Same-page fragments have unconfirmed source order.";
const STATUS = {
  all: "All stored indexed text included.",
  selected: "Selected stored text excerpts.",
  incomplete: "Index read incomplete; selected excerpts.",
  failed: "Stored-text retrieval failed; partial supplied excerpts only.",
  failedEmpty: "Stored-text retrieval failed; cannot infer missing material.",
  empty: "No stored text retrieved; original content not assessed.",
  incompleteEmpty: "Index read incomplete; no stored text retrieved.",
};
const LONGEST_STATUS = Object.values(STATUS).reduce((longest, status) => status.length > longest.length ? status : longest, "");
const finiteScore = (score: number | undefined) => Number.isFinite(score) ? Math.max(0, Math.min(1, score!)) : 0;
const pageOrder = (a: MaterialContextChunk, b: MaterialContextChunk) => a.startPage - b.startPage || a.endPage - b.endPage || a.id.localeCompare(b.id);
const key = (chunk: MaterialContextChunk) => `${chunk.documentId}:${chunk.id}`;
const chunkLabel = (chunk: MaterialContextChunk, truncated = false) => `[p.${chunk.startPage}${chunk.endPage === chunk.startPage ? "" : `-${chunk.endPage}`}]${truncated ? " (excerpt truncated)" : ""}\n`;

export function buildMaterialContext(input: {
  documents: MaterialContextDocument[];
  chunks: MaterialContextChunk[];
  question: string;
  anchor: string;
  maxCharacters?: number;
}): { text: string; sources: Source[] } {
  const budget = input.maxCharacters === undefined ? MAX_MATERIAL_CONTEXT_CHARACTERS
    : Number.isFinite(input.maxCharacters) ? Math.max(0, Math.min(MAX_MATERIAL_CONTEXT_CHARACTERS, Math.floor(input.maxCharacters))) : 0;
  if (!budget || !input.documents.length) return { text: "", sources: [] };
  const documents = [...new Map(input.documents.map((document) => [document.id, document])).values()];
  const byDocument = new Map(documents.map((document) => [document.id, [] as MaterialContextChunk[]]));
  const unique = new Map<string, MaterialContextChunk>();
  for (const chunk of input.chunks) {
    if (!byDocument.has(chunk.documentId) || !Number.isSafeInteger(chunk.startPage) || chunk.startPage < 1 ||
      !Number.isSafeInteger(chunk.endPage) || chunk.endPage < chunk.startPage || !chunk.text.trim()) continue;
    const previous = unique.get(key(chunk));
    unique.set(key(chunk), {
      ...chunk, text: previous?.text ?? chunk.text.trim(),
      semanticScore: Math.max(finiteScore(previous?.semanticScore), finiteScore(chunk.semanticScore)),
      anchorScore: Math.max(finiteScore(previous?.anchorScore), finiteScore(chunk.anchorScore)),
    });
  }
  const chunks = [...unique.values()];
  for (const chunk of chunks) byDocument.get(chunk.documentId)!.push(chunk);
  for (const rows of byDocument.values()) rows.sort(pageOrder);
  const filename = (document: MaterialContextDocument) => JSON.stringify(document.filename.replace(/\s+/gu, " ").slice(0, 200));
  const header = (document: MaterialContextDocument, status: string) => `Material ${filename(document)}\nIndex status: ${status}`;
  let shownDocuments = documents;
  let omitted = 0;
  const render = (selected: Map<string, Excerpt>, reserveHeaders = false) => {
    const sections = [INTRO];
    if (omitted) sections.push(`${omitted} other attached material identities were omitted from this context budget.`);
    const sources: Source[] = [];
    for (const document of shownDocuments) {
      const rows = byDocument.get(document.id)!;
      const excerpts = rows.flatMap((chunk) => { const excerpt = selected.get(key(chunk)); return excerpt ? [excerpt] : []; });
      const all = rows.length > 0 && excerpts.length === rows.length && excerpts.every((excerpt) => !excerpt.truncated);
      const status = document.indexReadFailed ? (excerpts.length ? STATUS.failed : STATUS.failedEmpty)
        : !excerpts.length ? (document.indexComplete ? STATUS.empty : STATUS.incompleteEmpty)
        : !document.indexComplete ? STATUS.incomplete : all ? STATUS.all : STATUS.selected;
      sections.push([header(document, reserveHeaders ? LONGEST_STATUS : status), ...excerpts.map((excerpt) => {
        sources.push({ documentId: document.id, filename: document.filename, startPage: excerpt.chunk.startPage, endPage: excerpt.chunk.endPage });
        return chunkLabel(excerpt.chunk, excerpt.truncated) + excerpt.text;
      })].join("\n\n"));
    }
    return { text: sections.join("\n\n"), sources: [...new Map(sources.map((source) => [`${source.documentId}:${source.startPage}:${source.endPage}`, source])).values()] };
  };
  const full = new Map(chunks.map((chunk) => [key(chunk), { chunk, text: chunk.text, truncated: false }]));
  if (documents.every((document) => document.indexComplete && !document.indexReadFailed)) {
    const result = render(full);
    if (result.text.length <= budget) return result;
  }

  const questionTerms = materialSearchTerms(input.question);
  const anchorTerms = materialSearchTerms(input.anchor);
  const matches = (text: string, terms: string[]) => terms.reduce((count, term) => count + Number(text.includes(term)), 0);
  const scores = new Map(chunks.map((chunk) => {
    const text = chunk.text.normalize("NFKC").toLowerCase();
    return [key(chunk), matches(text, questionTerms) * 10 + finiteScore(chunk.semanticScore) * 6
      + Math.min(6, matches(text, anchorTerms)) * (questionTerms.length ? 0.5 : 4)
      + finiteScore(chunk.anchorScore) * (questionTerms.length ? 2 : 6)];
  }));
  const ranked = [...chunks].sort((a, b) => scores.get(key(b))! - scores.get(key(a))! || pageOrder(a, b));
  const documentScores = new Map(documents.map((document) => [document.id, Math.max(0, ...byDocument.get(document.id)!.map((chunk) => scores.get(key(chunk))!))]));
  shownDocuments = [...documents].sort((a, b) => documentScores.get(b.id)! - documentScores.get(a.id)!);
  // Tiny caller budgets cannot fit every identity. Retain the most relevant
  // documents and disclose the omission before allocating excerpt space.
  while (shownDocuments.length > 1 && render(new Map(), true).text.length > budget * 0.55) {
    shownDocuments = shownDocuments.slice(0, -1);
    omitted++;
  }
  const selected = new Map<string, Excerpt>();
  let remaining = budget - render(selected, true).text.length;
  const shownIds = new Set(shownDocuments.map((document) => document.id));
  const add = (chunk: MaterialContextChunk, limit = 6_000) => {
    if (selected.has(key(chunk)) || !shownIds.has(chunk.documentId)) return;
    const fullCost = 2 + chunkLabel(chunk).length + chunk.text.length;
    const length = fullCost <= remaining && chunk.text.length <= limit ? chunk.text.length
      : Math.min(limit, remaining - 2 - chunkLabel(chunk, true).length);
    if (length < 1) return;
    const truncated = length < chunk.text.length;
    const lower = chunk.text.normalize("NFKC").toLowerCase();
    const positions = [...questionTerms, ...anchorTerms].map((term) => lower.indexOf(term)).filter((position) => position >= 0);
    const start = truncated && positions.length ? Math.max(0, Math.min(...positions) - Math.floor(length / 3)) : 0;
    const text = chunk.text.slice(start, start + length);
    selected.set(key(chunk), { chunk, text, truncated });
    remaining -= 2 + chunkLabel(chunk, truncated).length + text.length;
  };
  const primary = ranked.filter((chunk) => scores.get(key(chunk))! > 0 && shownIds.has(chunk.documentId));
  const firstByDocument = [...new Map([...primary].reverse().map((chunk) => [chunk.documentId, chunk])).values()]
    .sort((a, b) => scores.get(key(b))! - scores.get(key(a))!);
  const firstLimit = Math.max(1, Math.min(6_000, Math.floor(remaining / Math.max(1, firstByDocument.length)) - 50));
  for (const chunk of firstByDocument) add(chunk, firstLimit);
  for (const chunk of firstByDocument) {
    const rows = byDocument.get(chunk.documentId)!;
    const index = rows.indexOf(chunk);
    for (const neighbor of [rows[index - 1], rows[index + 1]]) {
      if (neighbor && neighbor.startPage <= chunk.endPage + 1 && neighbor.endPage >= chunk.startPage - 1) add(neighbor, 1_800);
    }
  }
  for (const chunk of primary) add(chunk);
  for (const document of shownDocuments) {
    const overview = byDocument.get(document.id)![0];
    if (overview) add(overview, 400);
  }
  for (const chunk of ranked) {
    const existing = selected.get(key(chunk));
    if (existing?.truncated) {
      const extra = chunkLabel(chunk).length + chunk.text.length - chunkLabel(chunk, true).length - existing.text.length;
      if (extra <= remaining) {
        selected.set(key(chunk), { chunk, text: chunk.text, truncated: false });
        remaining -= extra;
      }
    } else add(chunk);
  }
  const result = render(selected);
  if (result.text.length <= budget) return result;
  // Only a budget too small for even one identity can reach this branch;
  // selected excerpts were accounted for against the longest possible status.
  const notice = "Material context omitted: character budget too small.";
  return { text: notice.length <= budget ? notice : "", sources: [] };
}
