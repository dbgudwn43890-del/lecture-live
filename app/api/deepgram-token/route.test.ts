import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const USER_ID = randomUUID();
type Call = { table: string; op: string; payload?: unknown; filters: string[] };
type Outcome = { data?: unknown; error?: unknown };
let calls: Call[] = [];
let outcomes: Record<string, Outcome> = {};
let userId: string | null = USER_ID;
let rateAllowed = true;
let adminAvailable = true;
let providerRequests: string[] = [];
let relayRows: Array<{ user_id: string; session_id: string; connection_id: string | null; expires_at: string | null }> = [];

function queryBuilder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const settle = () => {
    if (!calls.includes(call)) calls.push(call);
    if (table === "stt_relay_sessions" && call.payload === "session_id") {
      if (outcomes["stt_relay_sessions.active"]) return Promise.resolve(outcomes["stt_relay_sessions.active"]);
      const rows = relayRows.filter(row => call.filters.every(filter => {
        const separator = filter.indexOf("=");
        const [operator, column] = filter.slice(0, separator).split(":");
        const value = filter.slice(separator + 1);
        const actual = row[column as keyof typeof row];
        if (operator === "eq") return actual === value;
        if (operator === "neq") return actual !== value;
        if (operator === "not") return value === "is.null" && actual !== null;
        if (operator === "gt") return actual !== null && Date.parse(actual) > Date.parse(value);
        return true;
      }));
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    }
    return Promise.resolve(outcomes[`${table}.${call.op}`] ?? { data: null, error: null });
  };
  const api = {
    select(columns?: string) { call.payload = columns; return api; },
    insert(payload: unknown) { call.op = "insert"; call.payload = payload; return api; },
    eq(column: string, value: unknown) { call.filters.push(`eq:${column}=${String(value)}`); return api; },
    neq(column: string, value: unknown) { call.filters.push(`neq:${column}=${String(value)}`); return api; },
    not(column: string, operator: string, value: unknown) { call.filters.push(`not:${column}=${operator}.${String(value)}`); return api; },
    gt(column: string, value: unknown) { call.filters.push(`gt:${column}=${String(value)}`); return api; },
    in(column: string, values: readonly unknown[]) { call.filters.push(`in:${column}=${values.join(",")}`); return api; },
    order() { return api; }, limit(count: number) { call.filters.push(`limit:count=${count}`); return api; }, maybeSingle: settle, single: settle,
    then(resolve: (value: Outcome) => unknown, reject?: (reason: unknown) => unknown) { return settle().then(resolve, reject); },
  };
  return api;
}
const supabaseStub = {
  from: queryBuilder,
  rpc(name: string, params?: unknown) {
    if (name === "consume_rate_limit") return Promise.resolve({ data: [{ allowed: rateAllowed, retry_after_seconds: 60 }], error: null });
    calls.push({ table: `rpc:${name}`, op: "rpc", payload: params, filters: [] });
    return Promise.resolve(outcomes[`rpc:${name}.rpc`] ?? { data: null, error: null });
  },
};
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    for (const extension of [".ts", ".js"]) { try { return nextResolve(`${specifier}${extension}`, context); } catch { /* next */ } }
    throw error;
  }
} });
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, { namedExports: { createClient: () => Promise.resolve(supabaseStub) } });
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => adminAvailable ? supabaseStub : null } });
mock.module(pathToFileURL("app/lib/auth.ts").href, { namedExports: { getAuthenticatedUserId: () => Promise.resolve(userId) } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async input => { providerRequests.push(String(input)); throw new Error("No network is allowed in the ticket route test"); }) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });
const { POST } = await import("./route.ts");
function tokenRequest(sessionId: string = randomUUID(), language: unknown = "ko", locale = "ko", transport: unknown = "pcm16") {
  return new Request("https://lecue.test/api/deepgram-token", { method: "POST", headers: { "X-Site-Locale": locale }, body: JSON.stringify({ sessionId, language, transport }) });
}
function configuration() {
  return (calls.findLast(call => call.table === "stt_relay_tickets" && call.op === "insert")?.payload as { configuration: { provider: string; listenUrl: string; sonioxConfig?: { language_hints: string[]; audio_format: string; sample_rate: number; num_channels: number } } }).configuration;
}
test.beforeEach(() => {
  userId = USER_ID; rateAllowed = true; adminAvailable = true; calls = []; providerRequests = []; relayRows = [];
  outcomes = {
    "consents.select": { data: [{ consent_type: "age_14" }, { consent_type: "recording" }] },
    "rpc:get_credit_status.rpc": { data: [{ credits: 5 }] },
    "lecture_sessions.select": { data: { id: "owned-session", status: "recording" } },
  };
  process.env.DEEPGRAM_API_KEY = "dg-private-test";
  process.env.STT_RELAY_URL = "wss://relay.lecue.test/listen";
  process.env.STT_RELAY_SECRET = "relay-private-test-secret-at-least-32-characters";
  delete process.env.SONIOX_API_KEY;
});
test.afterEach(() => assert.equal(providerRequests.length, 0, "ticket issuance never contacts a paid provider"));

test("signed-in consented recorder gets an opaque ticket, never a provider credential", async () => {
  const sessionId = randomUUID();
  const response = await POST(tokenRequest(sessionId));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.match(body.accessToken, /^[\w-]{43}$/);
  assert.equal(body.listenUrl, "wss://relay.lecue.test/listen");
  assert.equal(body.relay, true);
  assert.equal(body.credits, 5);
  assert.equal(JSON.stringify(body).includes("dg-private-test"), false);
  const stored = calls.find(call => call.table === "stt_relay_tickets")?.payload as { token_hash: string; user_id: string; session_id: string; expires_at: string };
  assert.equal(stored.token_hash, createHash("sha256").update(body.accessToken).digest("hex"));
  assert.equal(stored.user_id, USER_ID);
  assert.equal(stored.session_id, sessionId);
  assert.ok(Date.parse(stored.expires_at) > Date.now() && Date.parse(stored.expires_at) <= Date.now() + 30_000);
  assert.equal(calls.some(call => call.table.startsWith("rpc:consume_lecture")), false, "only the relay charges when opening the provider connection");
  const relayRead = calls.find(call => call.table === "stt_relay_sessions");
  assert.ok(relayRead?.filters.includes(`eq:user_id=${USER_ID}`));
});

test("another active lecture on the account returns an actionable localized conflict without minting a ticket", async () => {
  const sessionId = randomUUID();
  const activeSessionId = randomUUID();
  relayRows = [{ user_id: USER_ID, session_id: activeSessionId, connection_id: randomUUID(), expires_at: new Date(Date.now() + 20_000).toISOString() }];
  for (const locale of ["ko", "en"]) {
    const response = await POST(tokenRequest(sessionId, "ko", locale));
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.code, "RECORDING_ALREADY_ACTIVE");
    assert.equal(body.retryable, false);
    assert.equal(body.error, locale === "en"
      ? "Recording is already active in another tab or device. Pause or end that recording, then try again."
      : "다른 탭이나 기기에서 녹음 중입니다. 해당 녹음을 일시정지하거나 종료한 뒤 다시 시작해 주세요.");
    assert.equal(body.accessToken, undefined);
    assert.equal(body.listenUrl, undefined);
    assert.equal(JSON.stringify(body).includes(activeSessionId), false);
    assert.equal(JSON.stringify(body).includes("dg-private-test"), false);
  }
  assert.equal(calls.some(call => call.table === "stt_relay_tickets"), false);
  const activeRead = calls.find(call => call.table === "stt_relay_sessions" && call.payload === "session_id")!;
  assert.ok(activeRead.filters.includes(`eq:user_id=${USER_ID}`));
  assert.ok(activeRead.filters.includes(`neq:session_id=${sessionId}`));
  assert.ok(activeRead.filters.includes("not:connection_id=is.null"));
  assert.ok(activeRead.filters.some(filter => filter.startsWith("gt:expires_at=")));
  assert.ok(activeRead.filters.includes("limit:count=1"));
});

test("another user's live relay lease cannot block this account", async () => {
  relayRows = [{ user_id: randomUUID(), session_id: randomUUID(), connection_id: randomUUID(), expires_at: new Date(Date.now() + 20_000).toISOString() }];
  assert.equal((await POST(tokenRequest())).status, 200);
  assert.equal(calls.filter(call => call.table === "stt_relay_tickets").length, 1);
});

test("expired, closed, and unset relay leases do not block a new lecture", async () => {
  for (const lease of [
    { connection_id: randomUUID(), expires_at: new Date(Date.now() - 1_000).toISOString() },
    { connection_id: null, expires_at: new Date(Date.now() + 20_000).toISOString() },
    { connection_id: randomUUID(), expires_at: null },
  ]) {
    relayRows = [{ user_id: USER_ID, session_id: randomUUID(), ...lease }];
    assert.equal((await POST(tokenRequest())).status, 200);
  }
  assert.equal(calls.filter(call => call.table === "stt_relay_tickets").length, 3);
});

test("the same session may obtain a reconnect ticket while its old lease is still visible", async () => {
  const sessionId = randomUUID();
  relayRows = [{ user_id: USER_ID, session_id: sessionId, connection_id: randomUUID(), expires_at: new Date(Date.now() + 20_000).toISOString() }];
  assert.equal((await POST(tokenRequest(sessionId))).status, 200);
  assert.equal(calls.filter(call => call.table === "stt_relay_tickets").length, 1);
});

test("an unavailable account lease check fails closed without creating a ticket", async () => {
  outcomes["stt_relay_sessions.active"] = { error: { code: "DB_UNAVAILABLE" } };
  const response = await POST(tokenRequest());
  assert.equal(response.status, 503);
  assert.equal(calls.some(call => call.table === "stt_relay_tickets"), false);
});

test("material vocabulary stays unambiguous after composite ownership foreign keys are added", async () => {
  outcomes["lecture_sessions.select"] = { data: {
    status: "recording",
    classrooms: { glossary: "Eigenvector", material_documents: [{ keyterms: "OldTopic" }] },
    material_documents: [{ keyterms: "Gradient" }],
  } };
  const response = await POST(tokenRequest());
  assert.equal(response.status, 200);
  const selection = String(calls.find(call => call.table === "lecture_sessions")?.payload);
  assert.match(selection, /material_documents!material_documents_classroom_id_fkey\(keyterms\)/);
  assert.match(selection, /material_documents!material_documents_session_id_fkey\(keyterms\)/);
  const keyterms = new URL(configuration().listenUrl).searchParams.getAll("keyterm");
  assert.ok(keyterms.includes("Eigenvector"));
  assert.ok(keyterms.includes("Gradient"));
  assert.equal(keyterms.includes("OldTopic"), false);
});

for (const language of ["en", "ko", "es", "ja", "zh", "fr", "de", "pt", "hi"]) {
  test(`${language} stays in server-only Nova-3 PCM configuration`, async () => {
    const response = await POST(tokenRequest(randomUUID(), language));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sonioxConfig, undefined);
    const url = new URL(configuration().listenUrl);
    assert.equal(url.hostname, "api.deepgram.com");
    assert.equal(url.searchParams.get("language"), language);
    assert.equal(url.searchParams.get("model"), "nova-3");
    assert.equal(url.searchParams.get("encoding"), "linear16");
    assert.equal(url.searchParams.get("sample_rate"), "16000");
  });
}

test("mixed Korean-English uses only server-side Soniox PCM config", async () => {
  process.env.SONIOX_API_KEY = "soniox-private-test";
  const response = await POST(tokenRequest(randomUUID(), "multi"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, "soniox");
  assert.equal(body.listenUrl, "wss://relay.lecue.test/listen");
  assert.equal(body.sonioxConfig, undefined);
  assert.deepEqual(configuration().sonioxConfig?.language_hints, ["ko", "en"]);
  assert.equal(configuration().sonioxConfig?.audio_format, "pcm_s16le");
  assert.equal(configuration().sonioxConfig?.sample_rate, 16000);
  assert.equal(JSON.stringify(body).includes("soniox-private-test"), false);
});
test("mixed mode retains Korean fallback when Soniox is unavailable", async () => {
  const response = await POST(tokenRequest(randomUUID(), "multi"));
  assert.equal(response.status, 200);
  assert.equal(new URL(configuration().listenUrl).searchParams.get("language"), "ko");
});
test("missing language follows the display locale", async () => {
  for (const locale of ["en", "ko"]) {
    const response = await POST(tokenRequest(randomUUID(), null, locale));
    assert.equal(response.status, 200);
    assert.equal(new URL(configuration().listenUrl).searchParams.get("language"), locale);
  }
});
test("missing auth and consent never create a ticket", async () => {
  userId = null;
  assert.equal((await POST(tokenRequest())).status, 401);
  userId = USER_ID;
  outcomes["consents.select"] = { data: [{ consent_type: "age_14" }] };
  assert.equal((await POST(tokenRequest())).status, 403);
  outcomes["consents.select"] = { error: { code: "DB" } };
  assert.equal((await POST(tokenRequest())).status, 403);
  assert.equal(calls.some(call => call.table === "stt_relay_tickets"), false);
});
test("unknown ownership or nonrecording state cannot create a ticket", async () => {
  for (const session of [null, { status: "paused" }, { status: "completed" }, { status: "draft" }]) {
    outcomes["lecture_sessions.select"] = { data: session };
    assert.equal((await POST(tokenRequest())).status, 409);
  }
  assert.equal(calls.some(call => call.table === "stt_relay_tickets"), false);
});
test("zero credits requires cleanly closed, unconsumed prepaid allowance", async () => {
  outcomes["rpc:get_credit_status.rpc"] = { data: [{ credits: 0 }] };
  for (const relay of [null, { processed_bytes: 1920000, authorized_bytes: 1920000, connection_id: null }, { processed_bytes: 0, authorized_bytes: 1920000, connection_id: randomUUID() }]) {
    outcomes["stt_relay_sessions.select"] = { data: relay };
    assert.equal((await POST(tokenRequest())).status, 402);
  }
  outcomes["stt_relay_sessions.select"] = { data: { processed_bytes: 32000, authorized_bytes: 1920000, connection_id: null } };
  const response = await POST(tokenRequest());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).credits, 0);
});
test("credit, relay state, and ticket persistence errors fail closed", async () => {
  for (const key of ["rpc:get_credit_status.rpc", "stt_relay_sessions.select", "stt_relay_tickets.insert"]) {
    const original = outcomes[key]; outcomes[key] = { error: { code: "DB_UNAVAILABLE" } };
    assert.equal((await POST(tokenRequest())).status, 503);
    if (original) outcomes[key] = original; else delete outcomes[key];
  }
});
test("invalid transport, language and body are rejected before storage", async () => {
  for (const transport of ["webm", "", null]) assert.equal((await POST(tokenRequest(randomUUID(), "ko", "en", transport))).status, 409);
  assert.equal((await POST(new Request("https://lecue.test/api/deepgram-token", { method: "POST", body: JSON.stringify({ sessionId: randomUUID(), language: "ko" }) }))).status, 409);
  calls = [];
  assert.equal((await POST(tokenRequest(randomUUID(), "unsupported"))).status, 400);
  assert.equal((await POST(tokenRequest("invalid-id"))).status, 400);
  for (const body of ["{", "null", "[]"]) assert.equal((await POST(new Request("https://lecue.test/api/deepgram-token", { method: "POST", body }))).status, 400);
  assert.equal(calls.length, 0);
});
test("missing or invalid relay URL reports a nonretryable configuration error without exposing values", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  for (const url of ["", "http://relay.lecue.test/", "wss://user:password@relay.lecue.test/", "wss://relay.lecue.test/?secret=x"]) {
    process.env.STT_RELAY_URL = url;
    const response = await POST(tokenRequest());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "RECORDING_NOT_CONFIGURED", retryable: false, error: "녹음 연결 설정을 확인해야 합니다." });
  }
  delete process.env.STT_RELAY_URL;
  const english = await POST(tokenRequest(randomUUID(), "en", "en"));
  assert.equal(english.status, 503);
  assert.deepEqual(await english.json(), { code: "RECORDING_NOT_CONFIGURED", retryable: false, error: "The recording connection settings need to be checked." });
  assert.ok(logs.every(log => JSON.stringify(log) === JSON.stringify(["Recording configuration unavailable", ["STT_RELAY_URL"]])));
  assert.equal(calls.some(call => call.table === "stt_relay_tickets"), false);
});
test("the ticket issuer does not require a local callback secret", async () => {
  process.env.STT_RELAY_URL = "wss://relay.lecue.test/listen";
  for (const secret of [undefined, "short"]) {
    if (secret === undefined) delete process.env.STT_RELAY_SECRET;
    else process.env.STT_RELAY_SECRET = secret;
    const response = await POST(tokenRequest());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.accessToken, /^[\w-]{43}$/);
    assert.equal(body.listenUrl, "wss://relay.lecue.test/listen");
    assert.equal(body.relay, true);
  }
  assert.equal(calls.filter(call => call.table === "stt_relay_tickets").length, 2);
});
test("missing admin access still blocks ticket issuance with a configuration error", async t => {
  t.mock.method(console, "error", () => {});
  adminAvailable = false;
  const response = await POST(tokenRequest());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "RECORDING_NOT_CONFIGURED");
  assert.equal(body.retryable, false);
  assert.equal(calls.some(call => call.table === "stt_relay_tickets"), false);
});
test("shared rate limit blocks repeated ticket creation", async () => {
  rateAllowed = false;
  const response = await POST(tokenRequest());
  assert.equal(response.status, 429);
  assert.ok(response.headers.get("retry-after"));
  assert.equal(calls.some(call => call.table === "stt_relay_tickets"), false);
});
