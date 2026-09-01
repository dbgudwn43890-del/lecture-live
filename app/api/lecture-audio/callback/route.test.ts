import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// The HMAC in the query string is this route's entire authentication, and the
// credit-shortfall truncation decides what an unpaid caller receives — both
// are exercised here at the route level, not just in the lib.

const SECRET = "test-callback-secret";
process.env.LECTURE_AUDIO_CALLBACK_SECRET = SECRET;
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-secret";

type Call = {
  table: string;
  op: "insert" | "upsert" | "update" | "delete" | "select" | "rpc" | "storage-remove";
  payload?: unknown;
  filters: string[];
};

type Outcome = { data?: unknown; error?: unknown };

let calls: Call[] = [];
let outcomes: Record<string, Outcome | ((call: Call) => Outcome)> = {};

function outcomeFor(call: Call): Outcome {
  const outcome = outcomes[`${call.table}.${call.op}`];
  if (typeof outcome === "function") return outcome(call);
  return outcome ?? { data: null, error: null };
}

function queryBuilder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const settle = () => Promise.resolve(outcomeFor(call));
  const api = {
    insert(payload: unknown) { call.op = "insert"; call.payload = payload; calls.push(call); return api; },
    upsert(payload: unknown) { call.op = "upsert"; call.payload = payload; calls.push(call); return api; },
    update(payload: unknown) { call.op = "update"; call.payload = payload; calls.push(call); return api; },
    delete() { call.op = "delete"; calls.push(call); return api; },
    select(columns?: string) { if (call.op === "select") { call.payload = columns; calls.push(call); } return api; },
    eq(column: string, value: unknown) { call.filters.push(`eq:${column}=${String(value)}`); return api; },
    gte(column: string, value: unknown) { call.filters.push(`gte:${column}=${String(value)}`); return api; },
    maybeSingle: settle,
    single: settle,
    then(resolve: (value: Outcome) => unknown, reject?: (reason: unknown) => unknown) { return settle().then(resolve, reject); },
  };
  return api;
}

const adminStub = {
  from: queryBuilder,
  storage: {
    from: (bucket: string) => ({
      remove: (keys: string[]) => {
        calls.push({ table: `storage:${bucket}`, op: "storage-remove", payload: keys, filters: [] });
        return Promise.resolve({ error: null });
      },
    }),
  },
  rpc(name: string, params: unknown) {
    const call: Call = { table: `rpc:${name}`, op: "rpc", payload: params, filters: [] };
    calls.push(call);
    return Promise.resolve(outcomeFor(call));
  },
};

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

mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, {
  namedExports: { createAdminClient: () => adminStub },
});

class FakeOpenAI {
  embeddings = {
    create: (params: { input: string[] }) => {
      calls.push({ table: "openai:embeddings", op: "rpc", payload: params.input, filters: [] });
      return Promise.resolve({ data: params.input.map((_, index) => ({ embedding: [index], index })) });
    },
  };
  constructor(_options: unknown) {}
}
mock.module("openai", { defaultExport: FakeOpenAI });

const { POST } = await import("./route.ts");

function token(uploadId: string) {
  return createHmac("sha256", SECRET).update(uploadId).digest("hex");
}

function callbackRequest(uploadId: string, tokenValue: string, body: unknown) {
  return new Request(
    `https://lecue.test/api/lecture-audio/callback?uploadId=${uploadId}&token=${tokenValue}`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** metadata.duration 150s + three utterances, one per lecture minute. */
function threeMinutePayload() {
  return {
    metadata: { duration: 150 },
    results: {
      utterances: [
        { transcript: "첫 분의 문장", start: 5, end: 30 },
        { transcript: "둘째 분의 문장", start: 70, end: 90 },
        { transcript: "셋째 분의 문장", start: 130, end: 149 },
      ],
    },
  };
}

test.beforeEach(() => {
  calls = [];
  outcomes = {};
  process.env.OPENAI_API_KEY = "sk-test";
});

test("a forged token is turned away before any row is read", async () => {
  const uploadId = randomUUID();
  const response = await POST(callbackRequest(uploadId, token(randomUUID()), threeMinutePayload()));
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0, "a bad HMAC must not touch the database");
});

test("a token of the wrong length is turned away without throwing", async () => {
  const uploadId = randomUUID();
  const response = await POST(callbackRequest(uploadId, "short", threeMinutePayload()));
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test("a valid token completes the lecture and charges by measured minutes", async () => {
  const uploadId = randomUUID();
  const sessionId = randomUUID();
  const userId = randomUUID();
  outcomes["uploads.select"] = { data: { id: uploadId, session_id: sessionId, user_id: userId, object_key: "k", status: "processing" } };
  outcomes["lecture_sessions.select"] = { data: { id: sessionId, classroom_id: null, user_id: userId, status: "recording" } };
  outcomes["rpc:consume_lecture_credits_service.rpc"] = { data: [{ remaining_credits: 7, allowed: true, charged_through: 2 }] };

  const response = await POST(callbackRequest(uploadId, token(uploadId), threeMinutePayload()));
  assert.equal(response.status, 200);

  const charge = calls.find((call) => call.table === "rpc:consume_lecture_credits_service");
  assert.ok(charge);
  assert.equal((charge.payload as { p_minute_index: number }).p_minute_index, 2, "150s = minutes 0..2");
  const completed = calls.find((call) => call.table === "lecture_sessions" && call.op === "update");
  assert.equal((completed?.payload as { status: string }).status, "completed");
});

test("running out of credits mid-upload truncates the transcript at the paid minute", async () => {
  const uploadId = randomUUID();
  const sessionId = randomUUID();
  const userId = randomUUID();
  outcomes["uploads.select"] = { data: { id: uploadId, session_id: sessionId, user_id: userId, object_key: "k", status: "processing" } };
  outcomes["lecture_sessions.select"] = { data: { id: sessionId, classroom_id: null, user_id: userId, status: "recording" } };
  // Only minute 0 could be charged.
  outcomes["rpc:consume_lecture_credits_service.rpc"] = { data: [{ remaining_credits: 0, allowed: false, charged_through: 0 }] };

  const response = await POST(callbackRequest(uploadId, token(uploadId), threeMinutePayload()));
  assert.equal(response.status, 200);

  const trim = calls.find((call) => call.table === "transcript_segments" && call.op === "delete");
  assert.ok(trim, "the unpaid tail must be deleted");
  assert.ok(trim.filters.includes("gte:start_ms=60000"), `trim filters: ${trim.filters.join(", ")}`);

  const uploadDone = calls.find((call) => call.table === "uploads" && call.op === "update");
  assert.equal((uploadDone?.payload as { duration_ms: number }).duration_ms, 60_000, "the stored length is what was paid for");

  const embedded = calls.find((call) => call.table === "openai:embeddings");
  const embeddedText = (embedded?.payload as string[] | undefined)?.join(" ") ?? "";
  assert.ok(!embeddedText.includes("둘째"), "unpaid minutes must not be indexed either");
});

test("when not even the first minute can be charged the upload fails instead of delivering", async () => {
  const uploadId = randomUUID();
  const sessionId = randomUUID();
  const userId = randomUUID();
  outcomes["uploads.select"] = { data: { id: uploadId, session_id: sessionId, user_id: userId, object_key: "k", status: "processing" } };
  outcomes["lecture_sessions.select"] = { data: { id: sessionId, classroom_id: null, user_id: userId, status: "recording" } };
  outcomes["rpc:consume_lecture_credits_service.rpc"] = { data: [{ remaining_credits: 0, allowed: false, charged_through: -1 }] };

  const response = await POST(callbackRequest(uploadId, token(uploadId), threeMinutePayload()));
  assert.equal(response.status, 200);

  const failed = calls.find((call) => call.table === "uploads" && call.op === "update");
  assert.equal((failed?.payload as { status: string }).status, "failed");
  const sessionGone = calls.find((call) => call.table === "lecture_sessions" && call.op === "delete");
  assert.ok(sessionGone, "an undeliverable upload leaves no empty session behind");
  assert.ok(!calls.some((call) => call.table === "openai:embeddings"), "nothing to index");
});

test("a retried callback for a finished upload answers yes without re-charging", async () => {
  const uploadId = randomUUID();
  outcomes["uploads.select"] = { data: { id: uploadId, session_id: randomUUID(), user_id: randomUUID(), object_key: null, status: "completed" } };
  const response = await POST(callbackRequest(uploadId, token(uploadId), threeMinutePayload()));
  assert.equal(response.status, 200);
  assert.ok(!calls.some((call) => call.op === "rpc" && call.table.startsWith("rpc:consume")), "no second charge");
});
