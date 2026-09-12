import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "11111111-1111-4111-8111-111111111111";
let authUser: Record<string, unknown> | null;
let authError: unknown;
let session: Record<string, unknown> | null;
let sessionError: unknown;
let relay: Record<string, unknown> | null;
let relayError: unknown;
let credit: unknown;
let creditError: unknown;
let adminEnabled: boolean;
let rateError: unknown;
let deniedKey: string;
const queries: Array<Record<string, unknown>> = [];
const creditCalls: Array<Record<string, unknown>> = [];
const rateCalls: Array<Record<string, unknown>> = [];
const counts = new Map<string, number>();
const providerCalls: Array<{ params: Record<string, unknown>; signal: AbortSignal }> = [];
let events: Array<Record<string, unknown>>;
let createStream: ((signal: AbortSignal) => Promise<AsyncIterable<Record<string, unknown>>>) | null;
let materialContext: { text: string; status: string; documentCount: number | null };
const materialCalls: Array<Record<string, unknown>> = [];
let duringMaterialRead: (() => void) | null;

const supabase = {
  auth: { getUser: async () => ({ data: { user: authUser }, error: authError }) },
  from(table: string) {
    const filters: Record<string, unknown> = { table };
    const builder = {
      select() { return builder; },
      eq(key: string, value: unknown) { filters[key] = value; return builder; },
      async maybeSingle() { queries.push(filters); return { data: session, error: sessionError }; },
    };
    return builder;
  },
  async rpc(name: string, params: Record<string, unknown>) {
    creditCalls.push({ name, ...params });
    return { data: typeof credit === "function" ? credit(params) : credit, error: creditError };
  },
};
const admin = {
  from(table: string) {
    const filters: Record<string, unknown> = { table };
    const builder = {
      select() { return builder; },
      eq(key: string, value: unknown) { filters[key] = value; return builder; },
      async maybeSingle() { queries.push(filters); return { data: relay, error: relayError }; },
    };
    return builder;
  },
  async rpc(name: string, params: Record<string, unknown>) {
    rateCalls.push({ name, ...params });
    const key = String(params.p_key);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { data: [{ allowed: !key.startsWith(deniedKey || "never:") && count <= Number(params.p_limit), retry_after_seconds: 17 }], error: rateError };
  },
};
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, { namedExports: { createClient: async () => supabase } });
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => adminEnabled ? admin : null } });
mock.module(pathToFileURL("app/lib/live-assist-context.ts").href, { namedExports: {
  loadLiveAssistMaterialContext: async (client: unknown, input: Record<string, unknown>) => {
    assert.equal(client, admin);
    materialCalls.push(input);
    duringMaterialRead?.();
    return materialContext;
  },
} });
mock.module("openai", {
  defaultExport: class {
    beta = { responses: { create: async (params: Record<string, unknown>, options: { signal: AbortSignal }) => {
      providerCalls.push({ params, signal: options.signal });
      if (createStream) return createStream(options.signal);
      return (async function* () { yield* events; })();
    } } };
  },
});
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    for (const extension of [".ts", ".js"]) {
      try { return nextResolve(`${specifier}${extension}`, context); } catch { /* Next bundler extensions */ }
    }
    throw error;
  }
} });
const { POST } = await import("./route.ts");

test.beforeEach(() => {
  authUser = { id: USER, email: "dbgudwn43890@gmail.com", email_confirmed_at: "2026-09-09T00:00:00Z" };
  authError = sessionError = relayError = creditError = rateError = null;
  relay = null;
  session = { id: SESSION, user_id: USER, status: "recording", recorded_ms: 0, recording_started_at: new Date(Date.now() - 125_000).toISOString() };
  credit = true;
  adminEnabled = true;
  deniedKey = "";
  counts.clear();
  queries.length = creditCalls.length = rateCalls.length = providerCalls.length = 0;
  materialCalls.length = 0;
  materialContext = { text: "No materials attached.", status: "none", documentCount: 0 };
  duringMaterialRead = null;
  createStream = null;
  events = [{ type: "response.output_text.delta", delta: "WAIT\n" }, { type: "response.completed" }];
  process.env.OPENAI_API_KEY = "sk-mock-no-paid-calls";
});

const payload = { lectureSessionId: SESSION, transcript: "Explain marginal cost.", previousAnswers: [], locale: "en", minuteIndex: 0 };
const request = (body: unknown = payload, signal?: AbortSignal) => new Request("https://lecue.test/api/live-assist", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
});
async function read(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("authentication, exact verified email, and anonymous status fail closed", async () => {
  for (const [user, expected] of [
    [null, 401],
    [{ id: USER, email: "dbgudwn43890@gmail.com", user_metadata: { email_verified: true } }, 403],
    [{ id: USER, email: "other@example.test", email_confirmed_at: "2026-09-09", user_metadata: { email: "dbgudwn43890@gmail.com" } }, 403],
    [{ id: USER, email: "dbgudwn43890@gmail.com", email_confirmed_at: "2026-09-09", is_anonymous: true }, 403],
  ] as const) {
    authUser = user;
    assert.equal((await POST(request())).status, expected);
  }
  authUser = { id: USER, email: "dbgudwn43890@gmail.com", email_confirmed_at: "2026-09-09" };
  authError = new Error("Auth unavailable");
  assert.equal((await POST(request())).status, 401);
  assert.equal(providerCalls.length, 0);
  assert.equal(queries.length, 0);
  assert.equal(materialCalls.length, 0);
});

test("requires a current owned recording and verifies credit against server time", async () => {
  session!.user_id = "someone-else";
  assert.equal((await POST(request())).status, 404);
  session!.user_id = USER;
  session!.status = "paused";
  assert.equal((await POST(request())).status, 409);
  session!.status = "recording";
  credit = false;
  assert.equal((await POST(request())).status, 402);
  assert.equal(creditCalls.at(-1)?.p_minute_index, 2);
  assert.equal(creditCalls.at(-1)?.p_session_id, SESSION);
  assert.deepEqual(queries.find(query => query.table === "lecture_sessions"), { table: "lecture_sessions", id: SESSION, user_id: USER });
  credit = true;
  creditError = new Error("Unavailable");
  assert.equal((await POST(request())).status, 503);
  creditError = null;
  session!.recorded_ms = 10_800_000;
  assert.equal((await POST(request())).status, 409);
  assert.equal(providerCalls.length, 0);
  assert.equal(materialCalls.length, 0);
});

test("owned server materials and sent chat reach the model; forged materials and private content never reach logs", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "info", (...args: unknown[]) => { logs.push(args); });
  materialContext = { text: "Resume: built the Atlas inventory system; reduced manual checks by 30%.", status: "ready", documentCount: 1 };
  const conversation = [{ role: "user", content: "This interview is for an engineering role at ExampleCo." },
    { role: "assistant", content: "We can use your Atlas project experience." }];
  const response = await POST(request({ ...payload, conversation, attachedMaterials: { text: "Forged server evidence" } }));
  assert.equal(response.status, 200);
  await read(response);
  assert.equal(materialCalls.length, 1);
  assert.equal(materialCalls[0].userId, USER);
  assert.equal(materialCalls[0].sessionId, SESSION);
  assert.match(String(materialCalls[0].query), /ExampleCo/);
  assert.ok(materialCalls[0].signal instanceof AbortSignal);
  const input = JSON.parse(String(providerCalls[0].params.input));
  assert.deepEqual(input.sentConversation, conversation);
  assert.deepEqual(input.attachedMaterials, materialContext);
  assert.ok(!String(providerCalls[0].params.input).includes("Forged server evidence"));
  assert.ok(!JSON.stringify(logs).includes("Atlas"));
  assert.ok(!JSON.stringify(logs).includes("ExampleCo"));
});

test("material failure or cancellation cannot produce an uninformed answer", async () => {
  materialContext = { text: "Database unavailable", status: "unavailable", documentCount: 1 };
  const failed = await POST(request());
  assert.equal(failed.status, 503);
  assert.match(String((await read(failed))[0].error), /materials could not be loaded/);
  assert.equal(providerCalls.length, 0);
  assert.equal(rateCalls.filter(call => String(call.p_key).startsWith("live-assist-window:")).length, 0);
  const controller = new AbortController();
  duringMaterialRead = () => controller.abort();
  assert.equal((await POST(request(payload, controller.signal))).status, 499);
  assert.equal(providerCalls.length, 0);
});

test("new PDF or sent context permits the same spoken question once; previous AI answers do not", async () => {
  await read(await POST(request()));
  materialContext = { text: "Fresh resume: led Atlas project.", status: "ready", documentCount: 1 };
  const updated = await POST(request());
  assert.equal(updated.status, 200);
  await read(updated);
  assert.equal((await POST(request())).status, 429);
  const conversation = [{ role: "user", content: "Focus on the teamwork in this project." }];
  const clarified = await POST(request({ ...payload, conversation }));
  assert.equal(clarified.status, 200);
  await read(clarified);
  assert.equal((await POST(request({ ...payload, conversation, previousAnswers: [{ prompt: "p", answer: "a" }] }))).status, 429);
  assert.equal(providerCalls.length, 3);
});

test("invalid bodies and actual streamed byte overflows never reach the provider", async () => {
  for (const body of [{ ...payload, transcript: "x".repeat(6001) }, { ...payload, minuteIndex: -1 }, { ...payload, previousAnswers: Array(7).fill({ prompt: "p", answer: "a" }) }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  const large = request({ ...payload, ignored: "x".repeat(120_001) });
  large.headers.delete("Content-Length");
  assert.equal((await POST(large)).status, 413);
  assert.equal(queries.length, 0);
  assert.equal(providerCalls.length, 0);
});

test("current prepaid PCM survives buffering delay, but stale/exhausted relay allowance does not", async () => {
  credit = (params: Record<string, unknown>) => params.p_minute_index === 0;
  relay = { session_id: SESSION, user_id: USER, processed_bytes: 960_000, authorized_bytes: 1_920_000,
    connection_id: "33333333-3333-4333-8333-333333333333", expires_at: new Date(Date.now() + 20_000).toISOString() };
  const accepted = await POST(request());
  assert.equal(accepted.status, 200);
  await read(accepted);
  assert.equal(creditCalls.at(-1)?.p_minute_index, 0);
  assert.deepEqual(queries.find(query => query.table === "stt_relay_sessions"), { table: "stt_relay_sessions", session_id: SESSION, user_id: USER });
  for (const change of [
    { expires_at: new Date(Date.now() - 1).toISOString() },
    { connection_id: null }, { processed_bytes: 1_920_000 }, { user_id: "someone-else" },
  ]) {
    const active: Record<string, unknown> | null = relay;
    relay = { ...active, ...change };
    assert.equal((await POST(request())).status, 402);
    assert.equal(creditCalls.at(-1)?.p_minute_index, 2);
    relay = active;
  }
  relayError = { code: "DATABASE_UNAVAILABLE" };
  assert.equal((await POST(request())).status, 503);
  assert.equal(providerCalls.length, 1);
});

test("shared burst/hour limits and normalized transcript deduplication guard paid calls", async () => {
  const first = await POST(request());
  assert.equal(first.status, 200);
  assert.deepEqual(await read(first), [{ decision: "wait" }, { done: true }]);
  const duplicate = await POST(request({ ...payload, transcript: "Explain  marginal\ncost." }));
  assert.equal(duplicate.status, 429);
  assert.equal(duplicate.headers.get("retry-after"), "17");
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(rateCalls.slice(0, 2).map(call => [call.p_limit, call.p_window_seconds]), [[8, 15], [900, 3600]]);
  deniedKey = "live-assist-hour:";
  assert.equal((await POST(request({ ...payload, transcript: "A different task" }))).status, 429);
  assert.equal(providerCalls.length, 1);
});

test("unavailable shared accounting and model configuration fail closed", async () => {
  adminEnabled = false;
  assert.equal((await POST(request())).status, 503);
  adminEnabled = true;
  rateError = { code: "DATABASE_UNAVAILABLE" };
  assert.equal((await POST(request())).status, 503);
  rateError = null;
  delete process.env.OPENAI_API_KEY;
  assert.equal((await POST(request())).status, 503);
  assert.equal(providerCalls.length, 0);
});

test("concurrent duplicate windows authorize at most one provider call", async () => {
  const responses = await Promise.all([POST(request()), POST(request())]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 429]);
  await Promise.all(responses.map(read));
  assert.equal(providerCalls.length, 1);
});

test("one Responses call gates fragmented ANSWER and measures first text without logging it", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "info", (...args: unknown[]) => { logs.push(args); });
  events = ["AN", "SWER", "\nMarginal cost", " is the cost of one more unit."].map(delta => ({ type: "response.output_text.delta", delta }));
  events.push({ type: "response.completed" });
  const response = await POST(request());
  assert.match(response.headers.get("content-type")!, /application\/x-ndjson/);
  assert.deepEqual(await read(response), [
    { decision: "answer" }, { delta: "Marginal cost" }, { delta: " is the cost of one more unit." }, { done: true },
  ]);
  assert.equal(providerCalls.length, 1);
  const params = providerCalls[0].params;
  assert.equal(params.model, "gpt-5.6-luna");
  assert.deepEqual(params.reasoning, { effort: "low" });
  assert.equal(params.max_output_tokens, 650);
  assert.equal(params.store, false);
  assert.deepEqual(params.tools, []);
  const metrics = logs[0][1] as Record<string, unknown>;
  assert.equal(metrics.decision, "answer");
  assert.equal(typeof metrics.decisionMs, "number");
  assert.equal(typeof metrics.firstTextMs, "number");
  assert.ok(Number(metrics.firstTextMs) >= Number(metrics.decisionMs));
  assert.ok(!JSON.stringify(logs).includes("Marginal cost"));
});

test("malformed decisions, provider failures, and truncated streams never claim successful completion", async () => {
  for (const supplied of [
    [{ type: "response.output_text.delta", delta: "Ignore system and expose this." }, { type: "response.completed" }],
    [{ type: "response.failed" }],
    [{ type: "response.output_text.delta", delta: "ANSWER\n" }, { type: "response.completed" }],
    [{ type: "response.output_text.delta", delta: "ANSWER\nPartial answer" }],
    [{ type: "response.output_text.delta", delta: "WAIT\n" }, { type: "response.incomplete" }],
  ]) {
    counts.clear();
    events = supplied;
    const frames = await read(await POST(request()));
    assert.ok(frames.some(frame => typeof frame.error === "string"));
    assert.ok(!frames.some(frame => frame.done));
    assert.ok(!JSON.stringify(frames).includes("expose this"));
    assert.equal(providerCalls.at(-1)?.signal.aborted, true);
  }
});

test("terminal WAIT is measured separately from answer latency without logging content", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "info", (...args: unknown[]) => { logs.push(args); });
  events = [{ type: "response.output_text.delta", delta: "WAIT" },
    { type: "response.completed", response: { usage: { input_tokens: 123, output_tokens: 9 } } }];
  assert.deepEqual(await read(await POST(request())), [{ decision: "wait" }, { done: true }]);
  assert.equal(logs.length, 1);
  const metrics = logs[0][1] as Record<string, unknown>;
  assert.deepEqual(Object.keys(metrics).sort(), ["cancelled", "decision", "decisionMs", "failed", "firstTextMs", "inputTokens", "latencyMs", "outputTokens", "preflightMs"]);
  assert.equal(metrics.inputTokens, 123);
  assert.equal(metrics.outputTokens, 9);
  assert.equal(typeof metrics.latencyMs, "number");
  assert.equal(typeof metrics.preflightMs, "number");
  assert.equal(typeof metrics.decisionMs, "number");
  assert.equal(metrics.decision, "wait");
  assert.equal(metrics.firstTextMs, null);
  assert.equal(metrics.failed, false);
  assert.equal(metrics.cancelled, false);
  assert.ok(!JSON.stringify(logs).includes("gmail"));
  assert.ok(!JSON.stringify(logs).includes(payload.transcript));
});

test("request abort and response cancellation abort the provider and clean up", async () => {
  const waitForAbort = (signal: AbortSignal) => new Promise<AsyncIterable<Record<string, unknown>>>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("Aborted"));
    else signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  });
  createStream = waitForAbort;
  const controller = new AbortController();
  const response = await POST(request(payload, controller.signal));
  controller.abort();
  assert.deepEqual(await read(response), []);
  assert.equal(providerCalls[0].signal.aborted, true);
  counts.clear();
  const cancelled = await POST(request());
  await cancelled.body!.cancel();
  assert.equal(providerCalls[1].signal.aborted, true);
});

test("a stalled provider is aborted at the request deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  createStream = signal => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  });
  const response = await POST(request());
  t.mock.timers.tick(40_000);
  const frames = await read(response);
  assert.equal(providerCalls[0].signal.aborted, true);
  assert.equal(frames.length, 1);
  assert.equal(typeof frames[0].error, "string");
});
