import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const SESSION = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
type Row = Record<string, unknown>;
type Call = { table: string; columns?: string; filters: Row; offset?: number; payload?: Row; admin?: boolean };
let signedIn: boolean;
let verified: boolean;
let status: string;
let sessionExists: boolean;
let failures: Set<string>;
let calls: Call[];
let summaryRows: Row[];
let segmentRows: Row[];
let modelCalls: Row[];
let leaseCalls: string[];
let generationRows: Row[];
let adminCalls: { name: string; args: Row }[];
let claimResult: string;
let adminAvailable: boolean;
let modelFailure: boolean;
let modelOutput: string;
let modelOptions: Row;
let claimError: boolean;
let saveError: boolean;
let segmentError: boolean;

function query(table: string, admin = false) {
  const filters: Row = {};
  let columns = "";
  const settle = () => {
    calls.push({ table, columns, filters: { ...filters }, admin });
    if (failures.has(table)) return { data: null, error: { code: "read-failed" } };
    if (table === "lecture_sessions") return { data: sessionExists ? { id: SESSION, classroom_id: null, status } : null, error: null };
    if (table === "lecture_summaries") return { data: summaryRows, error: null };
    if (table === "lecture_summary_generations") return { data: generationRows, error: null };
    return { data: segmentRows.at(-1) ?? null, error: null };
  };
  const builder = {
    select(value: string) { columns = value; return builder; },
    eq(key: string, value: unknown) { filters[key] = value; return builder; },
    order() { return builder; }, limit() { return builder; },
    async maybeSingle() { return settle(); },
    async range(start: number, end: number) {
      calls.push({ table, columns, filters: { ...filters }, offset: start });
      return { data: segmentRows.slice(start, end + 1), error: segmentError ? { code: "read-failed" } : null };
    },
    async upsert(payload: Row) {
      calls.push({ table, filters: { ...filters }, payload });
      summaryRows.push(payload);
      return { error: null };
    },
    then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) { return Promise.resolve(settle()).then(resolve, reject); },
  };
  return builder;
}

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    for (const extension of [".ts", ".js"]) { try { return nextResolve(`${specifier}${extension}`, context); } catch { /* Try the other extension. */ } }
    throw error;
  }
} });
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, { namedExports: { createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: signedIn ? { id: USER, email: "learner@example.test", email_confirmed_at: verified ? "2026-09-10T00:00:00Z" : undefined } : null }, error: null }) },
  from: query,
  rpc: async (name: string) => { leaseCalls.push(name); return { data: true, error: null }; },
}) } });
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => adminAvailable ? {
  from: (table: string) => query(table, true),
  rpc: async (name: string, args: Row) => {
    adminCalls.push({ name, args });
    if (name === "claim_lecture_summary_generation") {
      if (claimError) return { data: null, error: { code: "unavailable" } };
      if (Number(args.p_source_characters) > 60_000) return { data: "source-limit", error: null };
      if (claimResult !== "claimed") return { data: claimResult, error: null };
      generationRows.push({ window_index: args.p_window_index, attempts: 1, completed_at: null, ...args });
      return { data: "claimed", error: null };
    }
    if (saveError) return { data: false, error: { code: "write-failed" } };
    const generation = generationRows.find(row => row.p_token === args.p_token)!;
    const payload = { session_id: args.p_session_id, user_id: args.p_user_id, classroom_id: null,
      window_index: args.p_window_index, start_ms: Number(args.p_window_index) * 600_000,
      end_ms: generation.p_end_ms, text: args.p_text, source_characters: generation.p_source_characters };
    calls.push({ table: "lecture_summaries", filters: {}, payload, admin: true });
    summaryRows.push(payload);
    generation.completed_at = "2026-09-11T00:00:00Z";
    return { data: true, error: null };
  },
} : null } });
mock.module(pathToFileURL("app/lib/rate-limit.ts").href, { namedExports: { checkSharedRateLimit: async () => ({ allowed: true }) } });
class FakeOpenAI {
  constructor(options: Row) { modelOptions = options; }
  responses = { create: async (params: Row) => {
    modelCalls.push(params);
    assert.equal(adminCalls.at(-1)?.name, "claim_lecture_summary_generation");
    if (modelFailure) throw { status: 503 };
    return { output_text: modelOutput };
  } };
}
mock.module("openai", { defaultExport: FakeOpenAI });
const { GET, POST } = await import("./route.ts");

test.beforeEach(() => {
  signedIn = true; verified = true; status = "recording"; sessionExists = true;
  failures = new Set(); calls = []; summaryRows = []; segmentRows = []; modelCalls = []; leaseCalls = [];
  generationRows = []; adminCalls = []; claimResult = "claimed"; adminAvailable = true;
  claimError = false; saveError = false; segmentError = false; modelFailure = false; modelOptions = {};
  modelOutput = "TOPICS: 스택과 큐\nTERMS: LIFO, FIFO\nPOINTS:\n- 자료구조마다 꺼내는 순서가 다르다.";
  process.env.OPENAI_API_KEY = "sk-test";
});
function get(sessionId = SESSION, english = false) {
  return GET(new Request(`https://lecue.test/api/lecture-summaries?sessionId=${sessionId}`, { headers: english ? { "x-site-locale": "en" } : {} }));
}
function post() { return POST(new Request("https://lecue.test/api/lecture-summaries", { method: "POST", body: JSON.stringify({ sessionId: SESSION }) })); }

test("GET needs a verified sign-in and never caches even authentication errors", async () => {
  signedIn = false;
  const anonymous = await get();
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("Cache-Control"), "private, no-store");
  signedIn = true; verified = false;
  assert.equal((await get()).status, 401);
  assert.equal(calls.length, 0);
});

test("GET validates session id and checks owner before reading summaries", async () => {
  assert.equal((await get("bad-id")).status, 400);
  assert.equal(calls.length, 0);
  sessionExists = false;
  assert.equal((await get()).status, 404);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].filters, { id: SESSION, user_id: USER });
});

test("GET returns compact stored flow and latest pending time without reading transcript text or calling a model", async () => {
  summaryRows = [{ window_index: 0, start_ms: 0, end_ms: 600_000, text: "TOPICS: 스택\nTERMS: LIFO\nPOINTS:\n- 마지막 항목을 먼저 꺼낸다." }];
  segmentRows = [{ end_ms: 645_000, text: "PRIVATE RAW TRANSCRIPT" }];
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.sections[0].title, "스택");
  assert.deepEqual(body.sections[0].keywords, ["LIFO"]);
  assert.deepEqual(body.pending, { startMs: 600_000, endMs: 645_000 });
  assert.ok(!JSON.stringify(body).includes("PRIVATE RAW TRANSCRIPT"));
  assert.equal(calls.find(call => call.table === "transcript_segments")?.columns, "end_ms");
  assert.ok(calls.slice(1).every(call => call.filters.user_id === USER && call.filters.session_id === SESSION));
  assert.deepEqual(modelCalls, []);
  assert.deepEqual(leaseCalls, []);
});

test("GET distinguishes empty flow from read failure and keeps all responses private", async () => {
  assert.deepEqual(await (await get()).json(), { sections: [], pending: null });
  for (const table of ["lecture_sessions", "lecture_summaries", "transcript_segments"]) {
    failures = new Set([table]);
    const response = await get(SESSION, true);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.match((await response.json()).error, /Please try again/);
  }
});

test("POST leaves an active tail alone, then summarizes a completed short lecture only once", async () => {
  segmentRows = [{ start_ms: 0, end_ms: 90_000, text: "강의의 핵심 정의와 예시. ".repeat(80) }];
  assert.equal((await (await post()).json()).written, 0);
  assert.deepEqual(modelCalls, []);
  status = "completed";
  assert.equal((await (await post()).json()).written, 1);
  assert.equal(modelCalls.length, 1);
  const saved = calls.find(call => call.payload)?.payload;
  assert.equal(saved?.window_index, 0);
  assert.equal(saved?.end_ms, 90_000, "final partial window must not claim ten minutes of coverage");
  assert.equal((await (await post()).json()).written, 0);
  assert.equal(modelCalls.length, 1);
  assert.equal((await (await get()).json()).pending, null);
});

test("completed final-window reads cannot silently stop at the old 5000-segment cap", async () => {
  status = "completed";
  summaryRows = Array.from({ length: 8 }, (_, window_index) => ({ window_index }));
  segmentRows = Array.from({ length: 5_501 }, (_, index) => ({ start_ms: index * 1_000, end_ms: index * 1_000 + 500, text: index === 5500 ? "FINAL_MARKER " + "자료구조 ".repeat(100) : "자료구조 강의" }));
  await post();
  assert.deepEqual(calls.filter(call => call.offset !== undefined).map(call => call.offset), [0, 1000, 2000, 3000, 4000, 5000]);
  assert.ok(modelCalls.some(call => String(call.input).includes("FINAL_MARKER")));
});

function completedLecture() {
  status = "completed";
  segmentRows = [{ start_ms: 0, end_ms: 90_000, text: "강의 요약 내용. ".repeat(80) }];
}

test("POST verifies owner before accessing the service client or calling a paid model", async () => {
  completedLecture(); sessionExists = false;
  assert.equal((await post()).status, 404);
  assert.equal(calls.filter(call => call.admin).length, 0);
  assert.equal(modelCalls.length, 0);
  assert.ok(calls.every(call => call.filters.user_id === USER));
});

test("POST fails closed without admin, durable ledger, claim, or complete transcript", async () => {
  completedLecture(); adminAvailable = false;
  assert.equal((await post()).status, 503);
  adminAvailable = true; failures.add("lecture_summary_generations");
  assert.equal((await post()).status, 503);
  failures.clear(); segmentError = true;
  assert.equal((await post()).status, 503);
  segmentError = false; claimError = true;
  assert.equal((await post()).status, 503);
  assert.equal(modelCalls.length, 0);
});

test("POST never spends a paid call when the durable claim rejects it", async () => {
  completedLecture();
  for (claimResult of ["completed", "generating", "attempt-limit", "daily-budget", "source-limit", "unexpected"]) {
    const result = await (await post()).json();
    assert.equal(result.written, 0);
    assert.equal(result.skipped, claimResult === "unexpected" ? "unavailable" : claimResult);
  }
  assert.equal(modelCalls.length, 0);
});

test("a deleted summary result cannot replay its completed durable window", async () => {
  completedLecture();
  assert.equal((await (await post()).json()).written, 1);
  summaryRows = [];
  assert.equal((await (await post()).json()).written, 0);
  assert.equal(modelCalls.length, 1);
  assert.ok(calls.filter(call => call.payload).every(call => call.admin));
  assert.equal(modelOptions.maxRetries, 0, "one charged attempt permits exactly one SDK request");
});

test("exhausted windows do not consume the batch limit or starve later windows", async () => {
  status = "completed";
  generationRows = Array.from({ length: 4 }, (_, window_index) => ({ window_index, attempts: 2, completed_at: null }));
  segmentRows = Array.from({ length: 5 }, (_, i) => ({ start_ms: i * 600_000, end_ms: i * 600_000 + 60_000, text: "요약 내용. ".repeat(100) }));
  assert.equal((await (await post()).json()).written, 1);
  assert.equal(adminCalls[0].args.p_window_index, 4);
});

test("failed, empty and unsaved provider results keep the durable attempt charged", async () => {
  for (const failure of ["provider", "empty", "save"]) {
    generationRows = []; adminCalls = []; modelCalls = []; completedLecture();
    modelFailure = failure === "provider"; modelOutput = failure === "empty" ? "" : "Summary"; saveError = failure === "save";
    const response = await post();
    assert.equal(response.status, failure === "save" ? 500 : 200);
    assert.equal(modelCalls.length, 1);
    assert.equal(generationRows[0].attempts, 1);
    assert.equal(generationRows[0].completed_at, null);
    assert.equal(summaryRows.length, 0);
  }
});

test("oversized windows cannot starve later valid windows; at most three paid requests run", async () => {
  status = "completed";
  segmentRows = Array.from({ length: 8 }, (_, i) => ({ start_ms: i * 600_000, end_ms: i * 600_000 + 60_000,
    text: i < 3 ? "x".repeat(60_001) : "valid lecture ".repeat(50) }));
  assert.equal((await (await post()).json()).written, 3);
  assert.equal(modelCalls.length, 3);
  assert.deepEqual(adminCalls.filter(call => call.name === "complete_lecture_summary_generation").map(call => call.args.p_window_index), [3,4,5]);
});
