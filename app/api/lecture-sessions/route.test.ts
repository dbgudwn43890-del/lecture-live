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

type Outcome = { data?: unknown; error?: unknown; count?: number };
type SegmentRow = { client_id: string; start_ms: number; end_ms: number; text: string };

let calls: Call[] = [];
// A value may be a function when one table is queried more than once in a
// single request and each query needs its own answer (reconcile selects
// lecture_sessions twice: stale-recording, then completed-but-unindexed).
let outcomes: Record<string, Outcome | ((call: Call) => Outcome)> = {};
let segmentsBySession: Record<string, SegmentRow[]> = {};

function outcomeFor(call: Call): Outcome {
  const outcome = outcomes[`${call.table}.${call.op}`];
  if (typeof outcome === "function") return outcome(call);
  return outcome ?? { data: null, error: null };
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
    select(columns?: string, options?: unknown) { if (call.op === "select") { call.payload = columns; call.options = options; calls.push(call); } return api; },
    eq(column: string, value: unknown) { call.filters.push(`eq:${column}=${String(value)}`); return api; },
    lt(column: string, value: unknown) { call.filters.push(`lt:${column}=${String(value)}`); return api; },
    gt(column: string, value: unknown) { call.filters.push(`gt:${column}=${String(value)}`); return api; },
    in(column: string, values: unknown[]) { call.filters.push(`in:${column}=${values.join(",")}`); return api; },
    or(filter: string) { call.filters.push(`or:${filter}`); return api; },
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

// Billing-column writes go through the service key since 20260902000000; the
// same stub records those calls too.
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, {
  namedExports: {
    createAdminClient: () => ({
      ...supabaseStub,
      // checkSharedRateLimit also reaches this client; the tests are about
      // the handlers, so the shared limiter always says yes.
      rpc(name: string, params: unknown) {
        if (name === "consume_rate_limit") return Promise.resolve({ data: [{ allowed: true }], error: null });
        return supabaseStub.rpc(name, params);
      },
    }),
  },
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

const { GET, POST, PATCH } = await import("./route.ts");

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

test("a PDF can create a draft lecture and starting reuses that same session", async () => {
  const sessionId = randomUUID();
  const session = {
    id: sessionId,
    classroom_id: null,
    title: "8. 31. 수업",
    status: "draft",
    started_at: "2026-08-31T00:00:00.000Z",
    ended_at: null,
    duration_seconds: 0,
  };
  outcomes["lecture_sessions.insert"] = { data: session, error: null };

  const draftResponse = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "draft", classroomId: null, title: session.title }),
  }));
  assert.equal(draftResponse?.status, 201);
  assert.equal((calls.find((call) => call.table === "lecture_sessions" && call.op === "insert")?.payload as { status: string }).status, "draft");

  calls = [];
  outcomes["lecture_sessions.update"] = { data: { ...session, status: "recording" }, error: null };
  const startResponse = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "start", sessionId, classroomId: null, title: session.title }),
  }));
  assert.equal(startResponse?.status, 201);
  const activation = calls.find((call) => call.table === "lecture_sessions" && call.op === "update");
  assert.equal((activation?.payload as { status: string }).status, "recording");
  assert.ok(activation?.filters.includes(`eq:id=${sessionId}`));
  assert.ok(activation?.filters.includes("eq:status=draft"));
});

test("starting without a draft saves a recording session", async () => {
  const session = {
    id: randomUUID(), classroom_id: null, title: "바로 시작한 수업", status: "recording",
    started_at: "2026-08-31T00:00:00.000Z", ended_at: null, duration_seconds: 0,
  };
  outcomes["lecture_sessions.insert"] = { data: session, error: null };

  const response = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "start", classroomId: null, title: session.title }),
  }));

  assert.equal(response?.status, 201);
  assert.equal((calls.find((call) => call.table === "lecture_sessions" && call.op === "insert")?.payload as { status: string }).status, "recording");
});

test("pause and resume return the server-owned accumulated recording time", async () => {
  const sessionId = randomUUID();
  outcomes["rpc:pause_lecture_session.rpc"] = { data: [{ status: "paused", recorded_ms: 61_250 }], error: null };

  const pauseResponse = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "pause", sessionId }),
  }));
  assert.equal(pauseResponse?.status, 200);
  assert.deepEqual(await pauseResponse?.json(), { status: "paused", recordedMs: 61_250 });
  assert.deepEqual(calls.at(-1)?.payload, { p_session_id: sessionId });

  outcomes["rpc:resume_lecture_session.rpc"] = { data: [{ status: "recording", recorded_ms: 61_250 }], error: null };
  const resumeResponse = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "resume", sessionId }),
  }));
  assert.equal(resumeResponse?.status, 200);
  assert.deepEqual(await resumeResponse?.json(), { status: "recording", recordedMs: 61_250 });
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

test("reconcile indexes a completed lecture that never got chunks, and stops once it has them", async () => {
  const sessionId = randomUUID();
  const classroomId = randomUUID();
  // Nothing is stuck in "recording" — this lecture ended normally, but its
  // indexing run failed or was deferred, so it has no chunks and the stale
  // branch will never look at it again.
  outcomes["lecture_sessions.select"] = (call) =>
    call.filters.includes("in:status=recording,paused")
      ? { data: [], error: null }
      : { data: [{ id: sessionId, classroom_id: classroomId, user_id: USER_ID }], error: null };
  segmentsBySession[sessionId] = [
    { client_id: "a", start_ms: 0, end_ms: 1_000, text: "인덱싱이 빠진 채로 끝난 수업입니다." },
    { client_id: "b", start_ms: 1_000, end_ms: 2_000, text: "다음 질문에서 검색되지 않으면 영구 누락입니다." },
  ];
  outcomes["lecture_chunks.select"] = { data: [], error: null };
  outcomes["lecture_chunks.insert"] = { data: null, error: null };

  const response = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "reconcile" }),
  }));

  assert.ok(response);
  const body = await response.json() as { reconciled: number; indexed: number };
  assert.equal(body.reconciled, 0, "nothing was stuck recording");
  assert.equal(body.indexed, 1, "the un-indexed completed lecture is picked up anyway");
  assert.equal(embeddingsCalls.length, 1);

  const catchUpSelect = calls.find((call) =>
    call.table === "lecture_sessions" && call.op === "select" && call.filters.includes("eq:status=completed"));
  assert.ok(catchUpSelect, "the catch-up query must be bounded by a recency window");
  assert.ok(catchUpSelect!.filters.some((filter) => filter.startsWith("gt:ended_at=")));
  assert.ok(catchUpSelect!.filters.includes("gt:duration_seconds=0"));
});

test("reconcile leaves an already-indexed completed lecture alone", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = (call) =>
    call.filters.includes("in:status=recording,paused")
      ? { data: [], error: null }
      : { data: [{ id: sessionId, classroom_id: null, user_id: USER_ID }], error: null };
  segmentsBySession[sessionId] = [
    { client_id: "a", start_ms: 0, end_ms: 1_000, text: "이미 인덱싱된 수업입니다." },
  ];
  outcomes["lecture_chunks.select"] = { data: [{ session_id: sessionId }], error: null };

  const response = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "reconcile" }),
  }));

  assert.ok(response);
  assert.equal(embeddingsCalls.length, 0, "no transcript read, no embedding, for a lecture that already has chunks");
  const transcriptReads = calls.filter((call) => call.table === "transcript_segments");
  assert.deepEqual(transcriptReads, []);
});

test("completing a lecture that is already completed neither charges nor re-embeds", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = {
    data: { id: sessionId, classroom_id: null, started_at: "2026-08-27T00:00:00.000Z", status: "completed" },
    error: null,
  };

  const response = await PATCH(request("https://lecue.test/api/lecture-sessions", {
    method: "PATCH",
    body: JSON.stringify({
      sessionId,
      durationMs: 0,
      segments: Array.from({ length: 50 }, (_, index) => ({ id: `pad-${index}`, startMs: 0, endMs: 1_000, text: "x".repeat(200) })),
    }),
  }));

  assert.ok(response);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { completed: true, indexed: false });
  assert.equal(embeddingsCalls.length, 0);
  assert.equal(calls.filter((call) => call.op === "rpc").length, 0);
  assert.equal(calls.filter((call) => call.table === "transcript_segments" && call.op === "upsert").length, 0);
  assert.equal(calls.filter((call) => call.table === "lecture_sessions" && call.op === "update").length, 0);
});

test("a start that failed before the first sample is closed at zero and costs no credit", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = {
    // started_at is a minute old: billing off the clock alone would charge one
    // lecture-minute for a lecture that never recorded a sample.
    data: { id: sessionId, classroom_id: null, started_at: new Date(Date.now() - 60_000).toISOString(), status: "recording" },
    error: null,
  };
  outcomes["transcript_segments.select"] = { data: null, error: null, count: 0 };
  outcomes["lecture_sessions.update"] = { data: null, error: null };

  const response = await PATCH(request("https://lecue.test/api/lecture-sessions", {
    method: "PATCH",
    body: JSON.stringify({ sessionId, durationMs: 0, segments: [] }),
  }));

  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(calls.filter((call) => call.table === "rpc:consume_lecture_credits").length, 0);
  const update = calls.find((call) => call.table === "lecture_sessions" && call.op === "update");
  assert.equal((update?.payload as { duration_seconds: number }).duration_seconds, 0);
  assert.equal((update?.payload as { status: string }).status, "completed");
});

test("a lecture whose transcript is already in the database still reconciles its credits", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = {
    // 30s past the minute, not on it: the billable minute is derived with
    // Math.ceil, so an exact boundary lands on either side of it depending on
    // how long the test itself takes.
    data: { id: sessionId, classroom_id: null, started_at: new Date(Date.now() - (90 * 60_000 + 30_000)).toISOString(), status: "recording" },
    error: null,
  };
  // The client under-reports: durationMs 0 and an empty segment list. The rows
  // it saved live during the lecture are what the server counts instead.
  outcomes["transcript_segments.select"] = { data: null, error: null, count: 120 };
  outcomes["lecture_sessions.update"] = { data: null, error: null };

  const response = await PATCH(request("https://lecue.test/api/lecture-sessions", {
    method: "PATCH",
    body: JSON.stringify({ sessionId, durationMs: 0, segments: [] }),
  }));

  assert.ok(response);
  assert.equal(response.status, 200);
  const charge = calls.find((call) => call.table === "rpc:consume_lecture_credits");
  assert.ok(charge, "a 90-minute lecture with a stored transcript must still be charged");
  assert.equal((charge.payload as { p_minute_index: number }).p_minute_index, 90);
  const update = calls.find((call) => call.table === "lecture_sessions" && call.op === "update");
  const stored = (update?.payload as { duration_seconds: number }).duration_seconds;
  assert.ok(stored >= 5_430 && stored < 5_440, `duration_seconds ${stored} should track the elapsed 90m30s`);
});

test("segment save charges the lecture before writing, and refuses to write when credits run out", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = { data: { classroom_id: null }, error: null };
  outcomes["rpc:consume_lecture_credits_elapsed.rpc"] = { data: [{ allowed: false, remaining_credits: 0 }], error: null };

  const response = await POST(request("https://lecue.app/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({
      action: "segment",
      sessionId,
      segment: { id: "seg-1", startMs: 0, endMs: 2_000, text: "크레딧이 없을 때의 발화" },
    }),
  }));

  assert.ok(response);
  assert.equal(response.status, 402);
  // The whole point: a client that keeps a Deepgram socket open past its
  // credits must not keep getting its transcript saved.
  assert.equal(calls.filter((call) => call.table === "transcript_segments" && call.op === "upsert").length, 0);
  assert.equal(calls.filter((call) => call.table === "rpc:consume_lecture_credits_elapsed").length, 1);
});

test("segment save meters from the session id alone, never from anything the client sent", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = { data: { classroom_id: null }, error: null };
  outcomes["rpc:consume_lecture_credits_elapsed.rpc"] = { data: [{ allowed: true, remaining_credits: 40 }], error: null };
  outcomes["transcript_segments.upsert"] = { data: null, error: null };

  const response = await POST(request("https://lecue.app/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({
      action: "segment",
      sessionId,
      minuteIndex: 0,
      segment: { id: "seg-1", startMs: 0, endMs: 2_000, text: "정상 발화" },
    }),
  }));

  assert.ok(response);
  assert.equal(response.status, 200);
  const rpc = calls.find((call) => call.table === "rpc:consume_lecture_credits_elapsed");
  assert.deepEqual(rpc?.payload, { p_session_id: sessionId });
  assert.equal(calls.filter((call) => call.table === "transcript_segments" && call.op === "upsert").length, 1);
});
