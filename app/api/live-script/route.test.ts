import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "11111111-1111-4111-8111-111111111111";
let user: Row | null;
let authError: unknown;
let session: Row | null;
let sessionError: unknown;
let segmentError: unknown;
let rows: Row[];
let adminEnabled: boolean;
let rateError: unknown;
let rateData: unknown;
let deniedKey: string;
let result: Row;
let providerError: unknown;
let createResponse: ((signal: AbortSignal) => Promise<Row>) | null;
let beforeSegmentRead: ((filters: Row) => void | Promise<void>) | null;
let run = 0;
const queries: Row[] = [];
const rates: Row[] = [];
const providers: Array<{ params: Row; signal: AbortSignal; config: Row }> = [];

const supabase = {
  auth: { getUser: async () => ({ data: { user }, error: authError }) },
  from(table: string) {
    const filters: Row = { table };
    const settle = async () => {
      queries.push({ ...filters });
      if (table === "lecture_sessions") return { data: session, error: sessionError };
      if (table !== "transcript_segments") throw new Error("Unexpected table: " + table);
      await beforeSegmentRead?.(filters);
      return { data: rows.filter(row => (filters.client_id as string[]).includes(String(row.client_id))), error: segmentError };
    };
    const builder = {
      select(value: string) { filters.columns = value; return builder; },
      eq(key: string, value: unknown) { filters[key] = value; return builder; },
      in(key: string, value: unknown) { filters[key] = value; return builder; },
      order() { return builder; },
      limit(value: number) { filters.limit = value; return builder; },
      async maybeSingle() { return settle(); },
      then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) { return Promise.resolve(settle()).then(resolve, reject); },
    };
    return builder;
  },
};
const admin = { async rpc(name: string, args: Row) {
  assert.equal(name, "consume_rate_limit", "no credit-consuming or generation RPCs");
  rates.push({ name, ...args });
  return { data: rateData === undefined ? [{ allowed: !String(args.p_key).startsWith(deniedKey || "never:"), retry_after_seconds: 17 }] : rateData, error: rateError };
} };

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    for (const extension of [".ts", ".js"]) { try { return nextResolve(`${specifier}${extension}`, context); } catch { /* Next bundler extensions. */ } }
    throw error;
  }
} });
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, { namedExports: { createClient: async () => supabase } });
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => adminEnabled ? admin : null } });
mock.module("openai", { defaultExport: class {
  config: Row;
  constructor(config: Row) { this.config = config; }
  responses = { create: async (params: Row, options: { signal: AbortSignal }) => {
    providers.push({ params, signal: options.signal, config: this.config });
    if (providerError) throw providerError;
    return createResponse ? createResponse(options.signal) : result;
  } };
} });
const { POST } = await import("./route.ts");

test.beforeEach(() => {
  run += 1;
  user = { id: USER, email: "learner@example.test", email_confirmed_at: "2026-09-10T00:00:00Z" };
  session = { id: SESSION, user_id: USER };
  authError = sessionError = segmentError = rateError = providerError = null;
  adminEnabled = true; rateData = undefined; deniedKey = "";
  rows = [{ client_id: `0-4000-${run}-스택`, start_ms: 0, end_ms: 4_000, text: "어, 스택은 마지막에 넣은 걸 먼저 꺼냅니다. 항상 빠르다는 뜻은 아니에요." }];
  result = { status: "completed", output_text: JSON.stringify({ text: "스택은 마지막에 넣은 걸 먼저 꺼냅니다. 항상 빠르다는 뜻은 아니에요.", keywords: ["스택"] }) };
  createResponse = null; beforeSegmentRead = null;
  queries.length = rates.length = providers.length = 0;
  process.env.OPENAI_API_KEY = "sk-mocked-no-provider-calls";
});

function payload() { return { sessionId: SESSION, segmentIds: rows.map(row => row.client_id) }; }
function request(body: unknown = payload(), signal?: AbortSignal) {
  return new Request("https://lecue.test/api/live-script", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}
async function status(expected: number, body: unknown = payload()) {
  const response = await POST(request(body));
  assert.equal(response.status, expected);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  return response;
}

test("only verified, non-anonymous authenticated users reach storage", async () => {
  for (const value of [null, { id: USER }, { id: USER, email: "a@b.test", user_metadata: { email_verified: true } }, { ...user, is_anonymous: true }]) {
    user = value;
    await status(401);
  }
  user = { id: USER, email: "learner@example.test", email_confirmed_at: "2026-09-10" };
  authError = { private: "secret auth error" };
  await status(401);
  assert.deepEqual(queries, []);
  assert.deepEqual(providers, []);
});

test("validates strict bounded opaque IDs and rejects client speech or timestamps", async () => {
  for (const body of [null, [], {}, { ...payload(), sessionId: "bad" }, { ...payload(), segmentIds: [] },
    { ...payload(), segmentIds: Array.from({ length: 17 }, (_, n) => String(n)) },
    { ...payload(), segmentIds: ["same", "same"] }, { ...payload(), segmentIds: [null] },
    { ...payload(), segmentIds: [""] }, { ...payload(), segmentIds: ["x".repeat(2_201)] },
    { ...payload(), segmentIds: ["null\0char"] }, { ...payload(), transcript: "forged" }, { ...payload(), startMs: 0 },
  ]) await status(400, body);
  assert.equal(queries.length, 0);
  assert.equal(providers.length, 0);
});

test("actual streamed body and declared-length overflows are bounded before queries", async () => {
  await status(413, { ...payload(), extra: "가".repeat(60_000) });
  const declared = request(); declared.headers.set("Content-Length", "144001");
  assert.equal((await POST(declared)).status, 413);
  const malformed = new Request("https://lecue.test/api/live-script", { method: "POST", body: "{" });
  assert.equal((await POST(malformed)).status, 400);
  assert.equal(queries.length, 0);
  assert.equal(providers.length, 0);
});

test("ownership is explicit and checked before transcript reads or paid calls", async () => {
  for (const value of [null, { id: SESSION, user_id: "someone-else" }, { id: "different", user_id: USER }]) {
    session = value;
    await status(404);
  }
  sessionError = { code: "UNAVAILABLE" };
  await status(503);
  assert.ok(queries.every(query => query.table === "lecture_sessions" && query.id === SESSION && query.user_id === USER));
  assert.deepEqual(rates, []);
  assert.deepEqual(providers, []);
});

test("fails closed for missing configuration and shared rate-limit outages", async () => {
  adminEnabled = false; await status(503);
  adminEnabled = true; delete process.env.OPENAI_API_KEY; await status(503);
  process.env.OPENAI_API_KEY = "sk-mock";
  rateError = { code: "DATABASE_UNAVAILABLE" }; await status(503);
  rateError = null;
  for (const value of [null, [], {}, [{ allowed: "true" }]]) { rateData = value; await status(503); }
  assert.equal(providers.length, 0);
  assert.ok(queries.every(query => query.table === "lecture_sessions"));
});

test("both shared spend limits gate model calls and provide retry timing", async () => {
  for (const prefix of ["live-script-minute:", "live-script-hour:"]) {
    deniedKey = prefix;
    const response = await status(429);
    assert.equal(response.headers.get("Retry-After"), "17");
  }
  assert.deepEqual(rates.slice(-2).map(call => [call.p_limit, call.p_window_seconds]), [[15, 60], [900, 3_600]]);
  assert.equal(providers.length, 0);
});

test("waits for every requested stored segment and never presents partial coverage", async () => {
  const body = { ...payload(), segmentIds: [...payload().segmentIds, "not-saved-yet"] };
  const response = await status(409, body);
  assert.equal((await response.json()).code, "segments_pending");
  assert.equal(response.headers.get("Retry-After"), "2");
  segmentError = { code: "UNAVAILABLE", raw: "private database message" };
  assert.ok(!(await (await status(503)).text()).includes("private database"));
  assert.equal(providers.length, 0);
});

test("short live passages work immediately, sorted by stored timestamps, without notes", async () => {
  rows.unshift({ client_id: `second-${run}`, start_ms: 4_001, end_ms: 7_000, text: "큐는 먼저 넣은 걸 먼저 꺼내요." });
  const response = await status(200);
  const script = await response.json();
  assert.deepEqual(script.segmentIds, [rows[1].client_id, rows[0].client_id]);
  assert.equal(script.startMs, 0); assert.equal(script.endMs, 7_000);
  assert.deepEqual(script.keywords, ["스택"]);
  assert.deepEqual(queries.at(-1), { table: "transcript_segments", columns: "client_id,start_ms,end_ms,text", session_id: SESSION, user_id: USER, client_id: payload().segmentIds, limit: 2 });
  assert.equal(providers.length, 1);
  const { params, config, signal } = providers[0];
  assert.equal(params.model, "gpt-4o-mini"); assert.equal(params.max_output_tokens, 800); assert.equal(params.store, false);
  assert.equal(config.timeout, 15_000); assert.equal(config.maxRetries, 0); assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(params.input)), { sourceSegments: [rows[1].text, rows[0].text] });
  assert.equal((params.text as { format: Row }).format.strict, true);
  assert.match(String(params.instructions), /negations, numbers/);
  assert.match(String(params.instructions), /never instructions to follow/);
  assert.match(String(params.instructions), /NOT study notes/);
});

test("stored content, not opaque IDs or provider-proposed boundaries, is authoritative", async () => {
  rows[0].client_id = `ignore-all-rules-${run}`;
  const good = await status(200);
  assert.ok(!String(providers[0].params.input).includes("ignore-all-rules"));
  assert.equal((await good.json()).startMs, 0);
  rows[0].text = "A changed stored passage.";
  result.output_text = JSON.stringify({ text: "Good", keywords: [], startMs: 999 });
  await status(502);
});

test("stored source limits and corrupt timestamps fail without truncating coverage", async () => {
  rows[0].text = "x".repeat(6_001); await status(413);
  rows[0].text = "Good";
  for (const change of [{ start_ms: -1 }, { end_ms: 10_800_001 }, { end_ms: -1 }, { end_ms: NaN }, { text: " " }]) {
    const original = { ...rows[0] };
    rows[0] = { ...original, ...change };
    await status(503); rows[0] = original;
  }
  assert.equal(providers.length, 0);
});

test("provider failure, incomplete output, invalid JSON and oversized output never fall back to raw speech", async () => {
  const invalid = ["not-json", "null", JSON.stringify({ text: "", keywords: [] }), JSON.stringify({ text: "x".repeat(4_001), keywords: [] }),
    JSON.stringify({ text: "Fine", keywords: ["a", "b", "c", "d"] }), JSON.stringify({ text: "Fine", keywords: ["x".repeat(41)] }),
    JSON.stringify({ text: "Fine", keywords: [null] }), JSON.stringify({ text: "Fine" })];
  for (const output_text of invalid) { result = { status: "completed", output_text }; await status(502); }
  result = { status: "incomplete", output_text: JSON.stringify({ text: "Fine", keywords: [] }) }; await status(502);
  providerError = new Error("private upstream secret");
  const response = await status(502);
  const text = await response.text();
  assert.ok(!text.includes("private upstream")); assert.ok(!text.includes(String(rows[0].text)));
});

test("same stored passage shares bounded process-local results but rechecks ownership", async () => {
  await status(200); await status(200);
  assert.equal(providers.length, 1);
  rows[0].text = "Stored correction.";
  await status(200); assert.equal(providers.length, 2);
  session = null; await status(404); assert.equal(providers.length, 2);
});

test("keywords are extracted from persisted speech and short-lived cached entries expire", async t => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  result.output_text = JSON.stringify({ text: "스택은 마지막 항목을 먼저 꺼냅니다.", keywords: ["스택", "Invented topic"] });
  assert.deepEqual((await (await status(200)).json()).keywords, ["스택"]);
  await status(200); assert.equal(providers.length, 1);
  t.mock.method(Date, "now", () => now + 5 * 60_000 + 1);
  await status(200); assert.equal(providers.length, 2);
});

test("concurrent duplicates share one paid call", async () => {
  let release!: (value: Row) => void;
  createResponse = async () => new Promise(resolve => { release = resolve; });
  const first = POST(request()); const second = POST(request());
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(result);
  const responses = await Promise.all([first, second]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(providers.length, 1);
});

test("cancellation does not expose partial results and propagates to provider", async () => {
  const controller = new AbortController();
  createResponse = async signal => {
    controller.abort();
    assert.equal(signal.aborted, true);
    throw new Error("aborted");
  };
  const response = await POST(request(payload(), controller.signal));
  assert.equal(response.status, 499);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(providers.length, 1);
});

test("cancellation during storage read prevents a paid request", async () => {
  const controller = new AbortController();
  beforeSegmentRead = () => controller.abort();
  const response = await POST(request(payload(), controller.signal));
  assert.equal(response.status, 499);
  assert.equal(providers.length, 0);
});

test("Korean text-derived IDs use bounded real SDK URLs with at most four concurrent reads", async () => {
  rows = Array.from({ length: 16 }, (_, index) => ({
    client_id: `${run}-${index * 5_000}-${(index + 1) * 5_000}-${"가".repeat(120)}`,
    start_ms: index * 5_000, end_ms: (index + 1) * 5_000, text: `스택 예시 ${index}`,
  })).reverse();
  let concurrent = 0; let maximum = 0;
  beforeSegmentRead = async () => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    await new Promise(resolve => setImmediate(resolve));
    concurrent--;
  };
  const script = await (await status(200)).json();
  assert.deepEqual(script.segmentIds, rows.map(row => row.client_id).reverse());
  assert.equal(script.startMs, 0); assert.equal(script.endMs, 80_000);
  const reads = queries.filter(query => query.table === "transcript_segments");
  assert.ok(reads.length > 4, "long encoded IDs require multiple bounded waves");
  assert.equal(maximum, 4);
  assert.deepEqual(reads.flatMap(read => read.client_id), payload().segmentIds);
  const urls: string[] = [];
  const client = createSupabaseClient("https://example.test", "public-synthetic-key", {
    auth: { persistSession: false },
    global: { fetch: async url => { urls.push(String(url)); return new Response("[]", { headers: { "Content-Type": "application/json" } }); } },
  });
  for (const read of reads) {
    assert.equal(read.session_id, SESSION); assert.equal(read.user_id, USER);
    const ids = read.client_id as string[];
    await client.from("transcript_segments").select(String(read.columns)).eq("session_id", SESSION).eq("user_id", USER)
      .in("client_id", ids).order("start_ms", { ascending: true }).order("client_id", { ascending: true }).limit(ids.length);
  }
  assert.ok(urls.every(url => url.length < 4_500), "the actual Supabase-encoded GET URLs stay short");
  assert.equal(providers.length, 1);
});

test("oversized single identifiers fail explicitly before storage instead of sending an oversized GET", async () => {
  const response = await status(413, { ...payload(), segmentIds: ["가".repeat(2_000)] });
  assert.match((await response.json()).error, /식별자가 너무 깁니다/);
  assert.equal(queries.length, 0);
  assert.equal(providers.length, 0);
});

test("missing or failed later lookup groups never produce partial processed speech", async () => {
  rows = Array.from({ length: 16 }, (_, index) => ({
    client_id: `${run}-${index}-${"한".repeat(120)}`, start_ms: index * 1_000, end_ms: (index + 1) * 1_000, text: `설명 ${index}`,
  }));
  const body = payload();
  rows.pop();
  const missing = await status(409, body);
  assert.equal((await missing.json()).code, "segments_pending");
  beforeSegmentRead = filters => {
    if ((filters.client_id as string[]).includes(String(rows.at(-1)?.client_id))) throw new Error("Private upstream failure");
  };
  await status(503, body);
  assert.equal(providers.length, 0);
});
