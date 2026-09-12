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
  auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID, email: "learner@example.test", email_confirmed_at: "2026-09-07T00:00:00Z" } } }) },
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
      return Promise.resolve({ data: params.input.map((_, index) => ({ embedding: [index], index })) });
    },
  };
  constructor(_options: unknown) {}
}

mock.module("openai", { defaultExport: FakeOpenAI });

let afterCallbacks: Array<() => Promise<void>> = [];
mock.module("next/server", { namedExports: {
  NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  after: (callback: () => Promise<void>) => afterCallbacks.push(callback),
} });
const { GET, POST, PATCH, DELETE } = await import("./route.ts");
async function runAfter() { for (const callback of afterCallbacks.splice(0)) await callback(); }

function request(url: string, init?: RequestInit) {
  return new Request(url, init);
}

test.beforeEach(() => {
  calls = [];
  afterCallbacks = [];
  outcomes = {
    "rpc:reserve_lecture_index.rpc": { data: { allowed: true, claim_token: "index-claim" }, error: null },
    "rpc:finish_lecture_index.rpc": { data: true, error: null },
    "rpc:replace_lecture_index_service.rpc": { data: true, error: null },
    "rpc:save_lecture_final_service.rpc": call => {
      const value = call.payload as { p_session_id: string; p_segments: Array<{id:string}>; p_complete: boolean };
      return { data: { saved: true, completed: value.p_complete, acknowledgedSegmentIds: value.p_segments.map(segment => segment.id),
        session: { id: value.p_session_id, status: value.p_complete ? "completed" : "paused" }, indexingPending: value.p_complete } };
    },
  };
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

test("reconcile records completion through the shared-lock RPC and dispatches durable jobs after response", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = call => ({ data: call.filters.includes("in:status=recording,paused") ? [{ id: sessionId }] : { id: sessionId, classroom_id: null, status: "completed" } });
  outcomes["lecture_index_queue.select"] = { data: [{ session_id: sessionId }] };
  segmentsBySession[sessionId] = [{ client_id: "tail", start_ms: 0, end_ms: 1000, text: "Recovered transcript" }];
  const response = await POST(request("https://lecue.test/api/lecture-sessions", { method: "POST", body: JSON.stringify({ action: "reconcile" }) }));
  assert.equal(response?.status, 200);
  assert.deepEqual(await response!.json(), { reconciled: 1, indexed: 0, indexingDeferred: 1, hasMore: false });
  assert.equal(embeddingsCalls.length, 0, "saving must return before the provider request");
  assert.deepEqual(calls.find(call => call.table === "rpc:save_lecture_final_service")?.payload,
    { p_session_id: sessionId, p_user_id: USER_ID, p_segments: [], p_complete: true });
  await runAfter();
  assert.equal(embeddingsCalls.length, 1);
  assert.ok(calls.some(call => call.table === "rpc:replace_lecture_index_service"));
  assert.equal(calls.some(call => call.table === "lecture_chunks" && call.op === "delete"), false);
});

test("recovery indexes all 50,000 stored segments even when partial chunks already exist", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = call => ({ data: call.filters.includes("in:status=recording,paused") ? [] : { id: sessionId, classroom_id: null, status: "completed" } });
  outcomes["lecture_index_queue.select"] = { data: [{ session_id: sessionId }] };
  outcomes["lecture_chunks.select"] = { data: [{ session_id: sessionId }] };
  segmentsBySession[sessionId] = Array.from({ length: 50_000 }, (_, index) => ({ client_id: String(index), start_ms: index * 100, end_ms: (index + 1) * 100, text: index === 49_999 ? "LAST RECOVERED SENTENCE" : "x" }));
  const response = await POST(request("https://lecue.test/api/lecture-sessions", { method: "POST", body: JSON.stringify({ action: "reconcile" }) }));
  assert.equal(response?.status, 200);
  await runAfter();
  assert.ok(embeddingsCalls[0].input.some(text => text.includes("LAST RECOVERED SENTENCE")));
  assert.equal((calls.find(call => call.table === "rpc:replace_lecture_index_service")?.payload as { p_segment_count: number }).p_segment_count, 50_000);
});

test("already completed retries still send missing segments to the atomic save RPC", async () => {
  const sessionId = randomUUID();
  const segment = { id: "missing", startMs: 1000, endMs: 2000, text: "The missing paid sentence" };
  outcomes["lecture_sessions.select"] = { data: { id: sessionId, status: "completed" } };
  const response = await PATCH(request("https://lecue.test/api/lecture-sessions", { method: "PATCH", body: JSON.stringify({ sessionId, durationMs: 2000, segments: [segment] }) }));
  assert.equal(response?.status, 200);
  assert.deepEqual((await response!.json()).acknowledgedSegmentIds, ["missing"]);
  assert.deepEqual(calls.find(call => call.table === "rpc:save_lecture_final_service")?.payload,
    { p_session_id: sessionId, p_user_id: USER_ID, p_segments: [segment], p_complete: true });
  assert.equal(embeddingsCalls.length, 0);
});

for (const count of [251, 5001]) {
  test(`a legacy finish preserves all ${count} segments through bounded RPC batches`, async () => {
    const segments = Array.from({ length: count }, (_, index) => ({ id: String(index), startMs: index, endMs: index + 1, text: "tail" }));
    const response = await PATCH(request("https://lecue.test/api/lecture-sessions", { method: "PATCH", body: JSON.stringify({ sessionId: randomUUID(), durationMs: count, segments }) }));
    assert.equal(response?.status, 200);
    const saves = calls.filter(call => call.table === "rpc:save_lecture_final_service").map(call => call.payload as { p_segments: typeof segments; p_complete: boolean });
    assert.ok(saves.every(save => save.p_segments.length <= 250));
    assert.deepEqual(saves.flatMap(save => save.p_segments), segments);
    assert.equal(saves.at(-1)?.p_complete, true);
    assert.ok(saves.slice(0, -1).every(save => !save.p_complete));
    assert.equal((await response!.json()).acknowledgedSegmentIds.length, count);
  });
}

test("an oversized explicit batch rejects every segment without a partial acknowledgement", async () => {
  const response = await PATCH(request("https://lecue.test/api/lecture-sessions", { method: "PATCH", body: JSON.stringify({ action: "save-final", sessionId: randomUUID(), durationMs: 251,
    segments: Array.from({ length: 251 }, (_, index) => ({ id: String(index), startMs: index, endMs: index + 1, text: "tail" })) }) }));
  assert.equal(response?.status, 413);
  assert.equal(calls.some(call => call.table === "rpc:save_lecture_final_service"), false);
});

for (const code of ["RECORDING_ALREADY_ACTIVE", "RECOVERY_OUTSIDE_PAID_RECORDING", "SEGMENT_CONFLICT"]) {
  test(`final save preserves recovery data when the atomic guard reports ${code}`, async () => {
    outcomes["rpc:save_lecture_final_service.rpc"] = { data: { error: code } };
    const response = await PATCH(request("https://lecue.test/api/lecture-sessions", { method: "PATCH", body: JSON.stringify({ sessionId: randomUUID(), durationMs: 0, segments: [] }) }));
    assert.equal(response?.status, 409);
    assert.equal((await response!.json()).code, code);
    assert.equal(afterCallbacks.length, 0);
  });
}

test("recover reports an active lease without calling ordinary pause or changing the row", async () => {
  const sessionId = randomUUID();
  outcomes["rpc:recover_lecture_session_service.rpc"] = { data: { status: "recording", recordedMs: 60000, activeRecording: true } };
  const response = await POST(request("https://lecue.test/api/lecture-sessions", { method: "POST", body: JSON.stringify({ action: "recover", sessionId }) }));
  assert.deepEqual(await response!.json(), { status: "recording", recordedMs: 60000, activeRecording: true });
  assert.deepEqual(calls.find(call => call.table === "rpc:recover_lecture_session_service")?.payload, { p_session_id: sessionId, p_user_id: USER_ID });
  assert.equal(calls.some(call => call.table === "rpc:pause_lecture_session" || call.op === "update"), false);
});

test("recover returns the server-owned paused clock for an inactive session", async () => {
  outcomes["rpc:recover_lecture_session_service.rpc"] = { data: { status: "paused", recordedMs: 62000, activeRecording: false } };
  const response = await POST(request("https://lecue.test/api/lecture-sessions", { method: "POST", body: JSON.stringify({ action: "recover", sessionId: randomUUID() }) }));
  assert.deepEqual(await response!.json(), { status: "paused", recordedMs: 62000, activeRecording: false });
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

test("start stores the input source and defaults an older client to microphone", async () => {
  const session = {
    id: randomUUID(), classroom_id: null, title: "온라인 수업", status: "recording",
    started_at: "2026-09-06T00:00:00.000Z", ended_at: null, duration_seconds: 0, recorded_ms: 0, input_source: "browser-tab",
  };
  outcomes["lecture_sessions.insert"] = { data: session, error: null };

  const online = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "start", classroomId: null, title: session.title, inputSource: "browser-tab" }),
  }));
  assert.equal(online?.status, 201);
  assert.equal((calls.find((call) => call.table === "lecture_sessions" && call.op === "insert")?.payload as { input_source: string }).input_source, "browser-tab");
  assert.equal(((await online?.json()) as { session: { input_source: string } }).session.input_source, "browser-tab");

  calls = [];
  const legacy = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "start", classroomId: null, title: session.title }),
  }));
  assert.equal(legacy?.status, 201);
  assert.equal((calls.find((call) => call.table === "lecture_sessions" && call.op === "insert")?.payload as { input_source: string }).input_source, "microphone");
});

test("an unknown input source is a 400 and creates nothing", async () => {
  const response = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "start", classroomId: null, title: "수업", inputSource: "system-audio" }),
  }));
  assert.equal(response?.status, 400);
  assert.equal(calls.filter((call) => call.table === "lecture_sessions").length, 0);
});

test("a retried start with the same request id returns the existing session instead of a second one", async () => {
  const startRequestId = randomUUID();
  const session = {
    id: randomUUID(), classroom_id: null, title: "응답 유실", status: "recording",
    started_at: "2026-09-06T00:00:00.000Z", ended_at: null, duration_seconds: 0, recorded_ms: 0, input_source: "browser-tab",
  };
  // First attempt: nothing exists yet, insert lands.
  outcomes["lecture_sessions.select"] = { data: null, error: null };
  outcomes["lecture_sessions.insert"] = { data: session, error: null };
  const first = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "start", classroomId: null, title: session.title, inputSource: "browser-tab", startRequestId }),
  }));
  assert.equal(first?.status, 201);
  assert.equal((calls.find((call) => call.op === "insert")?.payload as { start_request_id: string }).start_request_id, startRequestId);

  // Retry after the response was lost: the lookup finds the row, no insert.
  calls = [];
  outcomes["lecture_sessions.select"] = { data: session, error: null };
  const retry = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "start", classroomId: null, title: session.title, inputSource: "browser-tab", startRequestId }),
  }));
  assert.equal(retry?.status, 201);
  assert.equal(((await retry?.json()) as { session: { id: string } }).session.id, session.id);
  assert.equal(calls.filter((call) => call.op === "insert").length, 0);

  // Two retries racing: the insert hits the unique index and the winner's row comes back.
  calls = [];
  let selects = 0;
  outcomes["lecture_sessions.select"] = () => ({ data: selects++ === 0 ? null : session, error: null });
  outcomes["lecture_sessions.insert"] = { data: null, error: { code: "23505" } };
  const raced = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "start", classroomId: null, title: session.title, startRequestId }),
  }));
  assert.equal(raced?.status, 201);
  assert.equal(((await raced?.json()) as { session: { id: string } }).session.id, session.id);
});

test("a start request id that is not a uuid is rejected", async () => {
  const response = await POST(request("https://lecue.test/api/lecture-sessions", {
    method: "POST",
    body: JSON.stringify({ action: "start", classroomId: null, title: "수업", startRequestId: "not-a-uuid" }),
  }));
  assert.equal(response?.status, 400);
});

test("a database failure during final save returns retryable failure and schedules no provider work", async () => {
  outcomes["rpc:save_lecture_final_service.rpc"] = { error: { code: "DB_UNAVAILABLE" } };
  const response = await PATCH(request("https://lecue.test/api/lecture-sessions", { method: "PATCH", body: JSON.stringify({ sessionId: randomUUID(), durationMs: 1000, segments: [{ id: "tail", startMs: 0, endMs: 1000, text: "unsaved tail" }] }) }));
  assert.equal(response?.status, 503);
  assert.equal(afterCallbacks.length, 0);
});

test("a completed recovery batch ACK does not dispatch indexing until the final empty confirmation", async () => {
  const sessionId = randomUUID();
  const segments = [{ id: "tail", startMs: 0, endMs: 1000, text: "new tail" }];
  outcomes["rpc:save_lecture_final_service.rpc"] = { data: { saved: true, completed: true, acknowledgedSegmentIds: ["tail"] } };
  const response = await PATCH(request("https://lecue.test/api/lecture-sessions", { method: "PATCH", body: JSON.stringify({ action: "save-final", sessionId, durationMs: 1000, segments }) }));
  assert.equal(response?.status, 200);
  assert.equal(afterCallbacks.length, 0);
  assert.equal((calls.find(call => call.table === "rpc:save_lecture_final_service")?.payload as { p_complete: boolean }).p_complete, false);
});

test("daily budget, paid interval, and claim denials prevent deferred embeddings", async () => {
  for (const reason of ["daily_budget", "unfunded_input", "already_claimed"]) {
    const sessionId = randomUUID();
    outcomes["lecture_sessions.select"] = { data: { id: sessionId, classroom_id: null, status: "completed" } };
    outcomes["rpc:reserve_lecture_index.rpc"] = { data: { allowed: false, reason } };
    segmentsBySession[sessionId] = [{ client_id: "paid", start_ms: 0, end_ms: 1000, text: "Transcript" }];
    const response = await PATCH(request("https://lecue.test/api/lecture-sessions", { method: "PATCH", body: JSON.stringify({ sessionId, durationMs: 1000, segments: [] }) }));
    assert.equal(response?.status, 200);
    assert.equal((await response!.json()).completed, true);
    await runAfter();
  }
  assert.equal(embeddingsCalls.length, 0);
});

test("relay delayed last transcript saves with zero credit without extra elapsed charge", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = { data: { classroom_id: null, status: "recording" } };
  outcomes["stt_relay_sessions.select"] = { data: { processed_bytes: 1920000, authorized_bytes: 1920000 } };
  const response = await POST(request("https://lecue.test/api/lecture-sessions", { method: "POST", body: JSON.stringify({ action: "segment", sessionId, segment: { id: "last", startMs: 59000, endMs: 60000, text: "Paid final sentence" } }) }));
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(calls.filter(call => call.table === "rpc:consume_lecture_credits_elapsed").length, 0);
});

test("session deletion retains cleanup work in cascade triggers and drains through service owner scope", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.delete"] = { data: { id: sessionId } };
  outcomes["rpc:claim_storage_deletions.rpc"] = { data: [] };
  const response = await DELETE(request(`https://lecue.test/api/lecture-sessions?sessionId=${sessionId}`, { method: "DELETE" }));
  assert.ok(response);
  assert.equal(response.status, 200);
  const deletion = calls.find(call => call.table === "lecture_sessions" && call.op === "delete");
  assert.ok(deletion?.filters.includes(`eq:user_id=${USER_ID}`));
  assert.equal(calls.filter(call => call.table === "material_documents").length, 0);
  assert.deepEqual(calls.find(call => call.table === "rpc:claim_storage_deletions")?.payload, { p_limit: 50, p_user_id: USER_ID });
});


test("reconcile leaves an active relay alone when completion refuses it", async () => {
  const sessionId = randomUUID();
  outcomes["lecture_sessions.select"] = { data: [{ id: sessionId }] };
  outcomes["rpc:save_lecture_final_service.rpc"] = { data: { error: "RECORDING_ALREADY_ACTIVE" } };
  const response = await POST(request("https://lecue.test/api/lecture-sessions", { method: "POST", body: JSON.stringify({ action: "reconcile" }) }));
  assert.equal((await response!.json()).reconciled, 0);
  assert.equal(calls.some(call => call.table === "lecture_sessions" && call.op === "update"), false);
});
