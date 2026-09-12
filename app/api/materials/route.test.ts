import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { extractBoundedPdf as realExtractBoundedPdf } from "../../lib/material-ingestion-pdf.ts";
import { compressedCommentPdf, compressedPdf } from "../../lib/material-pdf-fixture.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const DOCUMENT = "33333333-3333-4333-8333-333333333333";
let signedIn = true, ownedSession = true, saveFails = false, chunkFails = false, cleanupFails = false;
let calls: { client: string; table: string; operation: string; payload?: unknown; filters?: Record<string, unknown>; limit?: number }[] = [];
let queued: unknown[] = [], drains = 0, modelCalls = 0;
let pdfPageCount = 1, pdfFailPage = 0, pdfDestroyed = 0;
let pdfPagesRead: number[] = [];
let embeddingInputs: string[] = [];
let incompleteEmbeddings = false;
let pdfText: string | null = null;
let officeText = "";
let reserveResult: unknown = { allowed: true, claim_token: DOCUMENT };
let chargeResult: unknown = { allowed: true };
let reservationError = false;
let pdfFailure: string | null = null;
let useRealPdf = false;
let previewDocument: Record<string, unknown> | null = null;
let previewChunks: Array<Record<string, unknown>> = [];
let previewReadFails = false;
function containsUnsupportedText(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000") || !value.isWellFormed();
  if (Array.isArray(value)) return value.some(containsUnsupportedText);
  return Boolean(value && typeof value === "object" && Object.values(value).some(containsUnsupportedText));
}
function query(client: string, table: string) {
  let operation = "read", payload: unknown;
  const filters: Record<string, unknown> = {};
  let maximum = Infinity;
  const ordering: string[] = [];
  const b = {
    select() { return b; }, eq(key: string, value: unknown) { filters[key] = value; return b; },
    order(column: string) { ordering.push(column); return b; },
    limit(value: number) { maximum = value; return b; },
    insert(value: unknown) { operation = "insert"; payload = value; return b; },
    delete() { operation = "delete"; return b; },
    async maybeSingle() {
      calls.push({ client, table, operation, filters });
      const document = previewDocument && Object.entries(filters).every(([key, value]) => previewDocument![key] === value) ? previewDocument : null;
      return { data: table === "lecture_sessions" && ownedSession ? { id: SESSION, classroom_id: null } : table === "material_documents" ? document : null, error: null };
    },
    async single() {
      calls.push({ client, table, operation, payload });
      const unicodeError = containsUnsupportedText(payload);
      return { data: saveFails || unicodeError ? null : { id: DOCUMENT }, error: unicodeError ? { code: "22P05" } : saveFails ? { code: "failed" } : null };
    },
    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
      calls.push({ client, table, operation, payload, filters, limit: maximum });
      if (operation === "read" && table === "material_chunks") {
        const data = previewChunks.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value))
          .sort((a, b) => { for (const column of ordering) { const comparison = String(a[column]).localeCompare(String(b[column]), "en", { numeric: true }); if (comparison) return comparison; } return 0; }).slice(0, maximum);
        return Promise.resolve({ data, error: previewReadFails ? { code: "PRIVATE_RAW_ERROR", message: "private upstream response" } : null }).then(resolve, reject);
      }
      return Promise.resolve({ count: 0, error: containsUnsupportedText(payload) ? { code: "22P05" } : table === "material_chunks" && chunkFails ? { code: "failed" } : null }).then(resolve, reject);
    },
  };
  return b;
}
mock.module("next/server.js", { namedExports: { NextResponse: Response } });
mock.module(pathToFileURL("app/lib/material-ingestion-pdf.ts").href, { namedExports: { extractBoundedPdf: async (bytes: Uint8Array) => {
  if (useRealPdf) return realExtractBoundedPdf(bytes);
  try {
    if (pdfFailure) throw new Error(pdfFailure);
    if (pdfPageCount > 500) throw new Error("PDF_PAGE_LIMIT");
    const pages = [];
    for (let page = 1; page <= pdfPageCount; page++) {
      pdfPagesRead.push(page);
      if (page === pdfFailPage) throw new Error("page read failed");
      const text = (pdfText ?? `PAGE_${page}: This lecture explains the definition of an integral and how to calculate its value.`)
        .replaceAll("\u0000", "").toWellFormed().replace(/\s+/g, " ").trim();
      pages.push({ page, text });
    }
    return { pageCount: pdfPageCount, pages };
  } finally { pdfDestroyed++; }
} } });
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, { namedExports: { createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: signedIn ? { id: USER, email: "learner@example.test", email_confirmed_at: "2026-09-08T00:00:00Z" } : null } }) },
  from: (table: string) => query("owner", table),
  storage: { from: () => { throw new Error("Browser-authorized storage writes must not be used"); } },
}) } });
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => ({
  rpc: async (name: string, payload: unknown) => {
    calls.push({ client: "admin", table: name, operation: "rpc", payload });
    return { data: name === "reserve_material_upload" ? reserveResult : name === "charge_material_upload" ? chargeResult : null,
      error: reservationError && name !== "finish_material_upload" ? { code: "unavailable" } : null };
  },
  from: (table: string) => query("admin", table),
  storage: { from: (table: string) => ({ upload: async (_path: string, _data: unknown) => { calls.push({ client: "admin", table, operation: "upload" }); return { error: null }; } }) },
}) } });
mock.module(pathToFileURL("app/lib/rate-limit.ts").href, { namedExports: { checkSharedRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) } });
mock.module(pathToFileURL("app/lib/storage-cleanup.ts").href, { namedExports: {
  enqueueStorageDeletion: async (_admin: unknown, deletion: unknown) => { queued.push(deletion); },
  drainStorageDeletions: async () => { drains++; if (cleanupFails) throw new Error("retry later"); },
} });
class FakeOpenAI { embeddings = { create: async ({ input }: { input: string[] }) => {
  modelCalls++;
  embeddingInputs = input;
  return { data: incompleteEmbeddings ? [] : input.map((_, index) => ({ index, embedding: [1] })).reverse() };
} }; responses = { create: async () => { modelCalls++; return { output_text: officeText }; } }; }
mock.module("openai", { defaultExport: FakeOpenAI });
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    for (const extension of [".ts", ".js"]) { try { return nextResolve(`${specifier}${extension}`, context); } catch {} }
    throw error;
  }
} });
process.env.OPENAI_API_KEY = "test-only";
const { GET, POST, DELETE } = await import("./route.ts");
test.beforeEach(() => {
  signedIn = ownedSession = true; saveFails = chunkFails = cleanupFails = false;
  calls = []; queued = []; drains = modelCalls = 0;
  pdfPageCount = 1; pdfFailPage = pdfDestroyed = 0; pdfPagesRead = []; embeddingInputs = []; incompleteEmbeddings = false; pdfText = null; officeText = "";
  reserveResult = { allowed: true, claim_token: DOCUMENT }; chargeResult = { allowed: true }; reservationError = false; pdfFailure = null;
  useRealPdf = false;
  previewDocument = { id: DOCUMENT, user_id: USER, filename: "weighted-average.txt", page_count: 1, storage_path: "private/provider-secret.pdf" };
  previewChunks = [{ id: "first", document_id: DOCUMENT, user_id: USER, start_page: 1, end_page: 1, text: "10 students scored 90; 30 scored 70. The weighted average is 75." }];
  previewReadFails = false;
});
function upload(filename = "material.pdf", bytes?: Uint8Array<ArrayBuffer>) {
  const form = new FormData();
  form.set("sessionId", SESSION);
  form.set("file", new File([bytes ?? "%PDF-1.7 synthetic"], filename, { type: "application/pdf" }));
  return POST(new Request("https://lecue.test/api/materials", { method: "POST", body: form }));
}
test("normal PDF uploads and generated rows use server authority after owner validation", async () => {
  assert.equal((await upload()).status, 201);
  for (const table of ["materials", "material_documents", "material_chunks"]) {
    assert.ok(calls.some(c => c.table === table && c.client === "admin" && ["upload", "insert"].includes(c.operation)));
  }
});
test("a mathematical character across the chunk limit survives embedding and database storage intact", async () => {
  pdfText = "a".repeat(1799) + "𝑥² + 한글 日本語 😀";
  assert.equal((await upload()).status, 201);
  const stored = calls.find(c => c.table === "material_chunks" && c.operation === "insert")?.payload as { text: string }[];
  assert.equal(stored.map(chunk => chunk.text).join(""), pdfText);
  assert.deepEqual(embeddingInputs, stored.map(chunk => chunk.text));
  assert.ok(!containsUnsupportedText(stored));
  assert.equal(queued.length, 0);
});
test("PDF extraction artifacts cannot cause PostgreSQL 22P05 after successful embedding", async () => {
  pdfText = "한글\u0000 𝑥² = 4, 😀 \ud800끝\udc00";
  assert.equal((await upload()).status, 201);
  const stored = calls.find(c => c.table === "material_chunks" && c.operation === "insert")?.payload as { text: string }[];
  assert.equal(stored[0].text, "한글 𝑥² = 4, 😀 �끝�");
  assert.deepEqual(embeddingInputs, stored.map(chunk => chunk.text));
  assert.equal(queued.length, 0);
});
test("long Unicode PDF filenames are limited without splitting their final character", async () => {
  const filename = "a".repeat(199) + "𝑥.pdf";
  assert.equal((await upload(filename)).status, 201);
  const document = calls.find(c => c.table === "material_documents" && c.operation === "insert")?.payload as { filename: string };
  assert.equal(document.filename, "a".repeat(199) + "𝑥");
  assert.ok(document.filename.isWellFormed());
});
test("office extraction and truncated terminology stay safe for database storage too", async () => {
  officeText = `## p.1\n한글\u0000 𝑥² = 4\n## TERMS\n${"a".repeat(39)}𝑥`;
  assert.equal((await upload("slides.pptx")).status, 201);
  const document = calls.find(c => c.table === "material_documents" && c.operation === "insert")?.payload as { keyterms: string };
  assert.ok(document.keyterms.length > 0);
  assert.ok(!containsUnsupportedText(document));
  assert.deepEqual(embeddingInputs, ["한글 𝑥² = 4"]);
  assert.equal(queued.length, 0);
});
test("indexes every native PDF page, including topics in the middle and end", async () => {
  pdfPageCount = 24;
  assert.equal((await upload()).status, 201);
  assert.deepEqual(pdfPagesRead, Array.from({ length: 24 }, (_, index) => index + 1));
  const stored = calls.find(c => c.table === "material_chunks" && c.operation === "insert")?.payload as { text: string; embedding: number[] }[];
  for (let page = 1; page <= 24; page++) {
    assert.ok(embeddingInputs.some(text => text.includes(`PAGE_${page}:`)));
    assert.ok(stored.some(chunk => chunk.text.includes(`PAGE_${page}:`)));
  }
  assert.equal(pdfDestroyed, 1);
});
test("does not silently accept only the first 500 pages of a longer PDF", async () => {
  pdfPageCount = 501;
  const response = await upload();
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /500/);
  assert.equal(pdfPagesRead.length, 0);
  assert.equal(modelCalls, 0);
  assert.equal(pdfDestroyed, 1);
  assert.ok(!calls.some(c => ["upload", "insert"].includes(c.operation)));
});
test("a failed interior page read cannot save a partially indexed document", async () => {
  pdfPageCount = 12; pdfFailPage = 7;
  assert.equal((await upload()).status, 422);
  assert.equal(pdfDestroyed, 1);
  assert.equal(modelCalls, 0);
  assert.ok(!calls.some(c => ["upload", "insert"].includes(c.operation)));
});
test("incomplete embedding results cannot leave an uploaded but unsearchable document", async () => {
  incompleteEmbeddings = true;
  assert.equal((await upload()).status, 502);
  assert.ok(!calls.some(c => ["upload", "insert"].includes(c.operation)));
});
test("foreign session cannot invoke indexing or server storage writes", async () => {
  ownedSession = false;
  assert.equal((await upload()).status, 404);
  assert.equal(modelCalls, 0);
  assert.ok(!calls.some(c => c.client === "admin"));
});
test("failed document insert persists cleanup before the retryable drain", async () => {
  saveFails = cleanupFails = true;
  assert.equal((await upload()).status, 500);
  assert.equal(queued.length, 1);
  assert.equal(drains, 1);
});
test("failed chunk insert removes the tracking row and queues the original", async () => {
  chunkFails = true;
  assert.equal((await upload()).status, 500);
  assert.ok(calls.some(c => c.table === "material_documents" && c.operation === "delete"));
  assert.equal(queued.length, 1);
});
test("successful document deletion survives a temporarily unavailable cleanup worker", async () => {
  cleanupFails = true;
  const response = await DELETE(new Request(`https://lecue.test/api/materials?documentId=${DOCUMENT}`, { method: "DELETE" }));
  assert.equal(response.status, 200);
  assert.equal(drains, 1);
});
test("anonymous user cannot upload or delete", async () => {
  signedIn = false;
  assert.equal((await upload()).status, 401);
  assert.equal((await DELETE(new Request(`https://lecue.test/api/materials?documentId=${DOCUMENT}`, { method: "DELETE" }))).status, 401);
  assert.equal(calls.length, 0);
});

function preview(id = DOCUMENT, suffix = "text") {
  return GET(new Request(`https://lecue.test/api/materials?documentId=${id}&preview=${suffix}`, { headers: { "X-Site-Locale": "en" } }));
}
test("stored text previews work for non-PDF materials without reading original storage", async () => {
  previewDocument!.storage_path = null;
  const response = await preview();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { id: DOCUMENT, filename: "weighted-average.txt", pageCount: 1, status: "ready",
    preview: "10 students scored 90; 30 scored 70. The weighted average is 75.", excerpt: true });
  assert.equal(modelCalls, 0);
  assert.ok(calls.every(call => call.client === "owner"));
});
test("previews are bounded Unicode text and never return original paths or vectors", async () => {
  previewChunks[0].text = `## p.1\n${"𝑥".repeat(900)}`;
  previewChunks[0].embedding = [1, 2, 3];
  const response = await preview();
  const body = await response.json();
  assert.equal(Array.from(body.preview).length, 600);
  assert.ok(body.preview.isWellFormed());
  assert.equal(body.preview, "𝑥".repeat(600));
  assert.doesNotMatch(JSON.stringify(body), /storage_path|provider-secret|embedding|signedUrl/);
  assert.equal(calls.find(call => call.table === "material_chunks")?.limit, 2);
});
test("a preview enforces document and chunk ownership independently", async () => {
  previewChunks.unshift({ id: "foreign", document_id: DOCUMENT, user_id: "another-owner", start_page: 1, text: "PRIVATE CHUNK" });
  previewChunks.push({ id: "other", document_id: "another-document", user_id: USER, start_page: 1, text: "OTHER DOCUMENT" });
  assert.doesNotMatch(JSON.stringify(await (await preview()).json()), /PRIVATE CHUNK|OTHER DOCUMENT/);
  assert.deepEqual(calls.find(call => call.table === "material_documents")?.filters, { id: DOCUMENT, user_id: USER });
  assert.deepEqual(calls.find(call => call.table === "material_chunks")?.filters, { document_id: DOCUMENT, user_id: USER });
  calls = [];
  previewDocument!.user_id = "another-owner";
  assert.equal((await preview()).status, 404);
  assert.ok(!calls.some(call => call.table === "material_chunks"));
});
test("empty or unreadable indexes are not described as a completed text preview", async () => {
  previewChunks = [];
  const empty = await preview();
  assert.equal(empty.status, 200);
  assert.deepEqual({ ...await empty.json(), id: undefined, filename: undefined, pageCount: undefined }, { id: undefined, filename: undefined, pageCount: undefined, status: "empty", preview: "", excerpt: true });
  previewReadFails = true;
  const failed = await preview();
  assert.equal(failed.status, 503);
  const body = await failed.json();
  assert.match(body.error, /Could not load the extracted text/);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_RAW_ERROR|private upstream response/);
});
test("invalid and anonymous preview requests do not read material contents", async () => {
  assert.equal((await preview("invalid")).status, 400);
  assert.equal((await preview(DOCUMENT, "unknown")).status, 400);
  signedIn = false;
  assert.equal((await preview()).status, 401);
  assert.equal(calls.length, 0);
});

test("500,001 extracted PDF characters reject before embedding or storage", async () => {
  pdfText = "a".repeat(500_001);
  assert.equal((await upload()).status, 422);
  assert.equal(modelCalls, 0);
  assert.ok(!calls.some(c => ["upload", "insert"].includes(c.operation)));
  assert.ok(calls.some(c => c.table === "finish_material_upload"));
});
test("a real tiny compressed 500,001-character PDF is rejected before embedding", async () => {
  useRealPdf = true;
  const bytes = compressedPdf(["a".repeat(500_001)]);
  assert.ok(bytes.length < 2_000);
  assert.equal((await upload("compressed.pdf", bytes)).status, 422);
  assert.equal(modelCalls, 0);
  assert.ok(!calls.some(c => ["upload", "insert"].includes(c.operation)));
  assert.ok(calls.some(c => c.table === "finish_material_upload"));
});
test("an ordinary compressed PDF is completely extracted before embedding", async () => {
  useRealPdf = true;
  const topics = ["Introduction to bonds", "Compound interest", "Final portfolio example"];
  assert.equal((await upload("lecture.pdf", compressedPdf(topics))).status, 201);
  for (const topic of topics) assert.ok(embeddingInputs.some(text => text.includes(topic)));
});
test("a real compressed non-text expansion fails before any embedding request", async () => {
  useRealPdf = true;
  assert.equal((await upload("compressed-comment.pdf", await compressedCommentPdf(40 * 1024 * 1024))).status, 422);
  assert.equal(modelCalls, 0);
  assert.ok(!calls.some(c => ["upload", "insert"].includes(c.operation)));
});
test("conservative token budget rejects multilingual expansion before embedding", async () => {
  pdfText = "한".repeat(100_000);
  assert.equal((await upload()).status, 422);
  assert.equal(modelCalls, 0);
});
test("401 short native PDF pages still pack into 134 complete chunks", async () => {
  pdfText = "a".repeat(500); pdfPageCount = 401;
  // Three pages fit per chunk, so normal short-page documents remain accepted.
  assert.equal((await upload()).status, 201);
  assert.equal(embeddingInputs.length, 134);
});
test("atomic document reservation blocks a full lecture before extraction", async () => {
  reserveResult = { allowed: false, reason: "document_limit" };
  assert.equal((await upload()).status, 409);
  assert.equal(pdfPagesRead.length, 0);
  assert.equal(modelCalls, 0);
});
test("unavailable or malformed reservation fails closed before parsing and provider calls", async () => {
  for (const value of [null, {}, { allowed: true }, { allowed: true, claim_token: "bad" }, { allowed: false }]) {
    reserveResult = value;
    assert.equal((await upload()).status, 503);
  }
  reservationError = true;
  assert.equal((await upload()).status, 503);
  assert.equal(pdfPagesRead.length, 0);
  assert.equal(modelCalls, 0);
});
test("daily indexing budget fails closed before embedding and releases the slot", async () => {
  chargeResult = { allowed: false, reason: "daily_budget" };
  assert.equal((await upload()).status, 429);
  assert.equal(modelCalls, 0);
  assert.ok(calls.some(c => c.table === "finish_material_upload"));
  assert.ok(!calls.some(c => ["upload", "insert"].includes(c.operation)));
});
test("parser timeout releases the reservation and cannot save partial data", async () => {
  pdfFailure = "PDF_TIMEOUT";
  const response = await upload();
  assert.equal(response.status, 422);
  assert.equal(modelCalls, 0);
  assert.ok(calls.some(c => c.table === "finish_material_upload"));
  assert.ok(!calls.some(c => ["upload", "insert"].includes(c.operation)));
});
test("verified missing PDF runtime returns 503 and releases the reservation", async () => {
  pdfFailure = "PDF_RUNTIME_UNAVAILABLE";
  assert.equal((await upload()).status, 503);
  assert.equal(modelCalls, 0);
  assert.ok(calls.some(c => c.table === "finish_material_upload"));
  assert.ok(!calls.some(c => ["upload", "insert"].includes(c.operation)));
});
