import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    try { return nextResolve(`${specifier}.ts`, context); } catch { throw error; }
  }
} });
const { loadLiveAssistMaterialContext, LIVE_ASSIST_MATERIAL_CHARACTERS, LIVE_ASSIST_MATERIAL_TIMEOUT_MS } = await import("./live-assist-context.ts");

const USER = "owner-a", SESSION = "session-a";
type Document = { id: string; user_id: string; session_id: string; filename: string; created_at: string };
type Chunk = { id: string; document_id: string; user_id: string; start_page: number; end_page: number; text: string };
type Read = { table: string; filters: Record<string, string>; excludedIds: string[]; limit: number; lexical: string; signal?: AbortSignal };
const doc = (id = "resume", extra: Partial<Document> = {}): Document => ({ id, user_id: USER, session_id: SESSION, filename: `${id}.pdf`, created_at: "2026-09-10", ...extra });
const chunk = (documentId: string, page: number, text: string, extra: Partial<Chunk> = {}): Chunk => ({ id: `${documentId}-${String(page).padStart(3, "0")}`, document_id: documentId, user_id: USER, start_page: page, end_page: page, text, ...extra });

function fixture(documents: Document[], chunks: Chunk[]) {
  const reads: Read[] = [];
  let active = 0, peak = 0;
  let fail: ((read: Read) => boolean) | null = null;
  let wait: ((read: Read) => Promise<void> | undefined) | null = null;
  const admin = { from(table: string) {
    const read: Read = { table, filters: {}, excludedIds: [], limit: Infinity, lexical: "" };
    const builder = {
      select() { return builder; },
      eq(column: string, value: string) { read.filters[column] = value; return builder; },
      neq(column: string, value: string) { assert.equal(column, "id"); read.excludedIds.push(value); return builder; },
      order() { return builder; },
      limit(value: number) { read.limit = value; return builder; },
      or(value: string) { read.lexical = value; return builder; },
      abortSignal(signal: AbortSignal) { read.signal = signal; return builder; },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        reads.push(read); active++; peak = Math.max(peak, active);
        const result = (wait?.(read) ?? new Promise<void>(done => setImmediate(done))).then(() => {
          read.signal?.throwIfAborted();
          if (fail?.(read)) return { data: null, error: { code: "DB_UNAVAILABLE" } };
          const rows = (table === "material_documents" ? documents : chunks).filter(row =>
            Object.entries(read.filters).every(([column, value]) => row[column as keyof typeof row] === value) && !read.excludedIds.includes(row.id));
          const terms = read.lexical ? read.lexical.split(",").map(filter => {
            assert.match(filter, /^text\.ilike\.%[\p{L}\p{N}]+%$/u, "lexical filters must contain only literal words");
            return filter.slice("text.ilike.%".length, -1).toLowerCase();
          }) : [];
          const selected = terms.length ? rows.filter(row => "text" in row && terms.some(term => row.text.toLowerCase().includes(term))) : rows;
          return { data: selected.slice(0, read.limit), count: selected.length, error: null };
        }).finally(() => { active--; });
        return result.then(resolve, reject);
      },
    };
    return builder;
  } } as unknown as SupabaseClient;
  return {
    reads,
    get peak() { return peak; },
    failWhen(value: typeof fail) { fail = value; },
    waitWhen(value: typeof wait) { wait = value; },
    load(query = "이력서를 보고 지원자의 경력을 설명해줘", signal?: AbortSignal) {
      return loadLiveAssistMaterialContext(admin, { userId: USER, sessionId: SESSION, query, signal });
    },
  };
}

test("a short resume includes all stored text, including the final page, without model retrieval", async () => {
  const texts = ["지원자: 김지원. 경력: 데이터 분석가 3년.", "프로젝트: 고객 이탈 예측. 성과: 정확도 15% 개선.", "교육: 통계학 학사. 마지막 항목: 한국어·English·日本語, 𝑥²."];
  const f = fixture([doc()], texts.map((text, i) => chunk("resume", i + 1, text)));
  const result = await f.load();
  assert.equal(result.status, "ready");
  assert.equal(result.documentCount, 1);
  texts.forEach(text => assert.ok(result.text.includes(text)));
  assert.match(result.text, /All stored indexed text included/);
  assert.ok(result.text.length <= LIVE_ASSIST_MATERIAL_CHARACTERS);
  assert.equal(f.reads.length, 2);
  assert.ok(f.reads.every(read => read.filters.user_id === USER));
  assert.equal(f.reads[0].filters.session_id, SESSION);
  assert.equal(f.reads[1].filters.document_id, "resume");
});

test("same-classroom and foreign-user materials never enter the current session context", async () => {
  const f = fixture([
    doc(), doc("foreign", { user_id: "owner-b" }), doc("past-session", { session_id: "session-b" }),
  ], [
    chunk("resume", 1, "Owned resume evidence"),
    chunk("resume", 2, "FOREIGN OWNER SECRET", { user_id: "owner-b" }),
    chunk("foreign", 1, "FOREIGN DOCUMENT SECRET", { user_id: "owner-b" }),
    chunk("past-session", 1, "OTHER SESSION SECRET"),
  ]);
  const result = await f.load();
  assert.equal(result.status, "ready");
  assert.equal(result.documentCount, 1);
  assert.match(result.text, /Owned resume evidence/);
  assert.doesNotMatch(result.text, /SECRET|past-session|foreign/);
  assert.ok(f.reads.filter(read => read.table === "material_chunks").every(read => read.filters.document_id === "resume" && read.filters.user_id === USER));
});

test("uploads and deletions are reflected on the next call without a stale cache", async () => {
  const documents = [doc()], chunks = [chunk("resume", 1, "Original resume")];
  const f = fixture(documents, chunks);
  assert.equal((await f.load()).documentCount, 1);
  documents.unshift(doc("new-file"));
  chunks.push(chunk("new-file", 1, "Newly uploaded portfolio, including its last achievement."));
  const added = await f.load();
  assert.equal(added.documentCount, 2);
  assert.match(added.text, /last achievement/);
  documents.splice(documents.findIndex(document => document.id === "resume"), 1);
  const removed = await f.load();
  assert.equal(removed.documentCount, 1);
  assert.doesNotMatch(removed.text, /Original resume/);
});

test("a large document retrieves matching later chunks with a bounded lexical query", async () => {
  const chunks = Array.from({ length: 40 }, (_, i) => chunk("slides", i + 1,
    i === 34 ? "Kubernetes migration reduced deployment latency by 70 percent." : `Page ${i + 1}. ${"General background information. ".repeat(55)}`));
  const f = fixture([doc("slides")], chunks);
  const result = await f.load('Kubernetes 실적을 설명해줘 %_,.) "');
  assert.equal(result.status, "partial");
  assert.match(result.text, /Kubernetes migration reduced deployment latency by 70 percent/);
  assert.match(result.text, /Index read incomplete/);
  assert.ok(result.text.length <= LIVE_ASSIST_MATERIAL_CHARACTERS);
  const lexical = f.reads.find(read => read.lexical)!;
  assert.ok(lexical);
  assert.deepEqual(lexical.filters, { user_id: USER, document_id: "slides" });
  assert.equal(lexical.limit, 8);
  assert.ok(lexical.lexical.split(",").every(filter => /^text\.ilike\.%[\p{L}\p{N}]+%$/u.test(filter)));
});

test("frequent prefix matches cannot consume the later lexical hit budget", async () => {
  const chunks = Array.from({ length: 30 }, (_, i) => chunk("slides", i + 1, i < 12
    ? `Kubernetes overview ${i}.` : i === 24 ? "Kubernetes production migration cut costs by 40 percent." : `Unrelated page ${i + 1}.`));
  const f = fixture([doc("slides")], chunks);
  const result = await f.load("Kubernetes");
  assert.equal(result.status, "partial");
  assert.match(result.text, /production migration cut costs by 40 percent/);
  const lexical = f.reads.find(read => read.lexical)!;
  assert.deepEqual(lexical.excludedIds, chunks.slice(0, 12).map(row => row.id));
  assert.deepEqual(lexical.filters, { user_id: USER, document_id: "slides" });
});

test("all complete indexes still report partial coverage when the shared text budget trims them", async () => {
  const documents = [doc("one"), doc("two")];
  const chunks = documents.flatMap(document => Array.from({ length: 8 }, (_, i) => chunk(document.id, i + 1, `${document.id} ${i} ${"Readable resume detail. ".repeat(65)}`)));
  const result = await fixture(documents, chunks).load();
  assert.equal(result.status, "partial");
  assert.ok(result.text.length <= LIVE_ASSIST_MATERIAL_CHARACTERS);
  assert.match(result.text, /one\.pdf/);
  assert.match(result.text, /two\.pdf/);
  assert.match(result.text, /Selected stored text excerpts/);
});

test("document lookahead discloses omitted files and limits concurrent chunk reads to four", async () => {
  const documents = Array.from({ length: 24 }, (_, i) => doc(`doc-${i}`));
  const chunks = documents.map(document => chunk(document.id, 1, `${document.id} has a short complete record.`));
  const f = fixture(documents, chunks);
  const result = await f.load();
  assert.equal(result.status, "partial");
  assert.equal(result.documentCount, 24);
  assert.match(result.text, /Additional attached materials.*were not read/);
  assert.ok(result.text.length <= LIVE_ASSIST_MATERIAL_CHARACTERS);
  assert.equal(f.reads[0].limit, 21);
  assert.equal(f.reads.filter(read => read.table === "material_chunks").length, 20);
  assert.ok(f.peak <= 4);
});

test("missing chunks on an attached document are unavailable rather than silently ignored", async () => {
  const f = fixture([doc("ready"), doc("still-indexing")], [chunk("ready", 1, "Some available evidence")]);
  const result = await f.load();
  assert.equal(result.status, "unavailable");
  assert.equal(result.documentCount, 2);
  assert.doesNotMatch(result.text, /Some available evidence/);
  assert.match(result.text, /Do not infer that no material was uploaded/);
});

test("document, prefix and lexical database errors always stop grounding with unavailable status", async t => {
  t.mock.method(console, "error", () => {});
  for (const stage of ["documents", "prefix", "lexical"]) {
    const f = fixture([doc()], Array.from({ length: 20 }, (_, i) => chunk("resume", i + 1, `Kubernetes achievement ${i}`)));
    f.failWhen(read => stage === "documents" ? read.table === "material_documents"
      : read.table === "material_chunks" && (stage === "lexical" ? Boolean(read.lexical) : !read.lexical));
    const result = await f.load("Kubernetes");
    assert.equal(result.status, "unavailable", stage);
    assert.equal(result.documentCount, stage === "documents" ? null : 1);
    assert.doesNotMatch(result.text, /Kubernetes achievement/);
  }
});

test("no attached documents is distinct from retrieval failure and does not read chunks", async () => {
  const f = fixture([], []);
  const result = await f.load();
  assert.equal(result.status, "none");
  assert.equal(result.documentCount, 0);
  assert.equal(f.reads.length, 1);
});

test("cancellation propagates to database reads and never returns usable partial evidence", async () => {
  const f = fixture([doc()], [chunk("resume", 1, "Private resume evidence")]);
  const abort = new AbortController();
  const pending = f.load("resume", abort.signal);
  abort.abort();
  const result = await pending;
  assert.equal(result.status, "unavailable");
  assert.ok(f.reads.every(read => read.signal?.aborted));
  assert.doesNotMatch(result.text, /Private resume evidence/);
});

test("one total deadline covers document and chunk reads even when a transport ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([doc()], [chunk("resume", 1, "Private resume evidence")]);
  let releaseDocuments!: () => void;
  f.waitWhen(read => read.table === "material_documents"
    ? new Promise<void>(resolve => { releaseDocuments = resolve; })
    : new Promise<void>(() => {}));
  const pending = f.load();
  await Promise.resolve();
  t.mock.timers.tick(3_000);
  releaseDocuments();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.reads.length, 2);
  let settled = false;
  void pending.then(() => { settled = true; });
  t.mock.timers.tick(LIVE_ASSIST_MATERIAL_TIMEOUT_MS - 3_001);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.status, "unavailable");
  assert.equal(result.documentCount, 1);
  assert.ok(f.reads.every(read => read.signal?.aborted));
  assert.doesNotMatch(result.text, /Private resume evidence/);
});

test("successful retrieval clears its deadline and does not abort completed reads later", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([doc()], [chunk("resume", 1, "Complete evidence")]);
  assert.equal((await f.load()).status, "ready");
  t.mock.timers.tick(LIVE_ASSIST_MATERIAL_TIMEOUT_MS);
  assert.ok(f.reads.every(read => read.signal && !read.signal.aborted));
});
