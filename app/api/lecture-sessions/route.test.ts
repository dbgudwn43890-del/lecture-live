import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// Every call the handler makes against Supabase, in order, so a test can
// assert on what was written rather than on what the handler returned.
type Call = {
  table: string;
  op: "insert" | "upsert" | "update" | "delete" | "select" | "rpc";
  payload?: unknown;
  options?: unknown;
  filters: string[];
};

type Outcome = { data?: unknown; error?: unknown };
type SegmentRow = { client_id: string; start_ms: number; end_ms: number; text: string };

let calls: Call[] = [];
let outcomes: Record<string, Outcome> = {};
let segmentsBySession: Record<string, SegmentRow[]> = {};

function outcomeFor(call: Call): Outcome {
  return outcomes[`${call.table}.${call.op}`] ?? { data: null, error: null };
}

function filterValue(call: Call, prefix: string): string | undefined {
  const match = call.filters.find((filter) => filter.startsWith(prefix));
  return match?.slice(prefix.length);
}

function queryBuilder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  let range: [number, number] | null = null;

  const settle = (): Promise<Outcome> => {
    // The 1,000-row PostgREST cap is what this whole fix is about: a real
    // Supabase project truncates a plain select there. The stub mirrors that
    // by only ever returning the slice `.range()` asked for.
    if (table === "transcript_segments" && call.op === "select" && range) {
      const sessionId = filterValue(call, "eq:session_id=");
      const rows = segmentsBySession[sessionId ?? ""] ?? [];
      const [from, to] = range;
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
    }
    return Promise.resolve(outcomeFor(call));
  };

  const api = {
    insert(payload: unknown) { call.op = "insert"; call.payload = payload; calls.push(call); return api; },
    upsert(payload: unknown, options?: unknown) { call.op = "upsert"; call.payload = payload; call.options = options; calls.push(call); return api; },
    update(payload: unknown) { call.op = "update"; call.payload = payload; calls.push(call); return api; },
    delete() { call.op = "delete"; calls.push(call); return api; },
    select(columns?: string) { if (call.op === "select") { call.payload = columns; calls.push(call); } return api; },
    eq(column: string, value: unknown) { call.filters.push(`eq:${column}=${String(value)}`); return api; },
    lt(column: string, value: unknown) { call.filters.push(`lt:${column}=${String(value)}`); return api; },
    in(column: string, values: unknown[]) { call.filters.push(`in:${column}=${values.join(",")}`); return api; },
    order() { return api; },
    limit(n: number) { call.filters.push(`limit=${n}`); return api; },
    range(from: number, to: number) { range = [from, to]; return api; },
    maybeSingle: settle,
    single: settle,
    then(resolve: (value: Outcome) => unknown, reject?: (reason: unknown) => unknown) { return settle().then(resolve, reject); },
  };
  return api;
}

const USER_ID = "2f4fd830-c135-4ab7-bd81-6d060b5625b9";

const supabaseStub = {
  auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } } }) },
  from: queryBuilder,
  rpc(name: string, params: unknown) {
    const call: Call = { table: `rpc:${name}`, op: "rpc", payload: params, filters: [] };
    calls.push(call);
    return Promise.resolve(outcomeFor(call));
  },
};

// The route imports "next/server" and its sibling libs the way a bundler
// resolves them — no file extension. Node needs one, so retry with the
// extensions the repo actually uses before giving up. (Same pattern as
// app/api/billing/webhook/route.test.ts.)
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      for (const extension of [".ts", ".js"]) {
        try { return nextResolve(`${specifier}${extension}`, context); } catch { /* try the next one */ }
      }
      throw error;
    }
  },
});

mock.module(pathToFileURL("app/lib/supabase/server.ts").href, {
  namedExports: { createClient: () => Promise.resolve(supabaseStub) },
});

type EmbeddingsCall = { input: string[] };
let embeddingsCalls: EmbeddingsCall[] = [];

class FakeOpenAI {
  embeddings = {
    create: (params: EmbeddingsCall) => {
      embeddingsCalls.push(params);
      return Promise.resolve({ data: params.input.map((_, index) => ({ embedding: [index] })) });
    },
  };
  constructor(_options: unknown) {}
}

mock.module("openai", { defaultExport: FakeOpenAI });

const { GET, POST } = await import("./route.ts");

function request(url: string, init?: RequestInit) {
  return new Request(url, init);
}

test.beforeEach(() => {
  calls = [];
  outcomes = {};
  segmentsBySession = {};
  embeddingsCalls = [];
  process.env.OPENAI_API_KEY = "sk-test";
});

test("GET pages through more than 1,000 transcript segments instead of truncating at PostgREST's cap", async () => {
  const sessionId = randomUUID();
  const rowCount = 1_500;
  segmentsBySession[sessionId] = Array.from({ length: rowCount }, (_, index) => ({
    client_id: `seg-${index}`,
    start_ms: index * 1_000,
    end_ms: index * 1_000 + 900,
    text: `문장 ${index}`,
  }));
  outcomes["lecture_sessions.select"] = {
    data: { id: sessionId, classroom_id: null, title: "긴 강의", status: "completed", started_at: "2026-08-27T00:00:00.000Z", ended_at: null, duration_seconds: null },
    error: null,
  };
  outcomes["lecture_questions.select"] = { data: [], error: null };

  const response = await GET(request(`https://lecue.test/api/lecture-sessions?sessionId=${sessionId}`));
  assert.ok(response);
  assert.equal(response.status, 200);
  const body = await response.json() as { segments: unknown[] };
  assert.equal(body.segments.length, rowCount);
});

test("reconcile indexes the sessions it recovers so they don't vanish from RAG", async () => {
  const sessionId = randomUUID();
  const classroomId = randomUUID();
  outcomes["lecture_sessions.select"] = {
    data: [{ id: sessionId, classroom_id: classroomId, user_id: USER_ID }],
    error: null,
  };
  segmentsBySession[sessionId] = [
    { client_id: "a", start_ms: 0, end_ms: 1_000, text: "안녕하세요, 오늘 수업을 시작하겠습니다." },
    { client_id: "b", start_ms: 1_000, end_ms: 2_000, text: "지난 시간에 배운 내용을 복습해봅시다." },
  ];
  outcomes["lecture_chunks.select"] = { data: [], error: null }; // nothing indexed yet
  outcomes["lecture_chunks.insert"] = { data: null, error: null };

  const response = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "reconcile" }),
  }));

  assert.ok(response);
  assert.equal(response.status, 200);
  const body = await response.json() as { reconciled: number; indexed: number; indexingDeferred: number; hasMore: boolean };
  assert.equal(body.reconciled, 1);
  assert.equal(body.indexed, 1);
  assert.equal(body.indexingDeferred, 0);
  assert.equal(body.hasMore, false);

  assert.equal(embeddingsCalls.length, 1, "embeds the recovered session's transcript in one call");

  const completedUpdate = calls.find((call) => call.table === "lecture_sessions" && call.op === "update");
  assert.ok(completedUpdate, "the stale session must be marked completed");
  assert.equal((completedUpdate!.payload as { status: string }).status, "completed");

  const chunkInsert = calls.find((call) => call.table === "lecture_chunks" && call.op === "insert");
  assert.ok(chunkInsert, "the recovered session's chunks must be saved");
  const insertedRows = chunkInsert!.payload as { session_id: string }[];
  assert.ok(insertedRows.every((row) => row.session_id === sessionId));
});

test("reconcile skips re-embedding a session that already has chunks", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = {
    data: [{ id: sessionId, classroom_id: null, user_id: USER_ID }],
    error: null,
  };
  segmentsBySession[sessionId] = [
    { client_id: "a", start_ms: 0, end_ms: 1_000, text: "이미 인덱싱된 강의입니다." },
  ];
  outcomes["lecture_chunks.select"] = { data: [{ session_id: sessionId }], error: null };

  const response = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "reconcile" }),
  }));

  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(embeddingsCalls.length, 0);
  const body = await response.json() as { indexed: number };
  assert.equal(body.indexed, 0);
});
