import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// The routes that mint provider tokens are where consent enforcement and the
// credit preflight actually bite — this exercises them at the route level.

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-secret";
process.env.DEEPGRAM_API_KEY = "dg-test";

const USER_ID = randomUUID();

type Call = { table: string; op: string; payload?: unknown; filters: string[] };
type Outcome = { data?: unknown; error?: unknown };

let calls: Call[] = [];
let outcomes: Record<string, Outcome> = {};
let providerRequests: string[] = [];

function queryBuilder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const settle = () => {
    if (!calls.includes(call)) calls.push(call);
    return Promise.resolve(outcomes[`${table}.${call.op}`] ?? { data: null, error: null });
  };
  const api = {
    select(columns?: string) { call.payload = columns; return api; },
    eq(column: string, value: unknown) { call.filters.push(`eq:${column}=${String(value)}`); return api; },
    in(column: string, values: readonly unknown[]) { call.filters.push(`in:${column}=${values.join(",")}`); return api; },
    order() { return api; },
    limit() { return api; },
    maybeSingle: settle,
    single: settle,
    then(resolve: (value: Outcome) => unknown, reject?: (reason: unknown) => unknown) { return settle().then(resolve, reject); },
  };
  return api;
}

const supabaseStub = {
  auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } } }) },
  from: queryBuilder,
  rpc(name: string, params: unknown) {
    calls.push({ table: `rpc:${name}`, op: "rpc", payload: params, filters: [] });
    return Promise.resolve(outcomes[`rpc:${name}.rpc`] ?? { data: null, error: null });
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

mock.module(pathToFileURL("app/lib/supabase/server.ts").href, {
  namedExports: { createClient: () => Promise.resolve(supabaseStub) },
});
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, {
  namedExports: {
    createAdminClient: () => ({
      rpc: (name: string) => Promise.resolve(
        name === "consume_rate_limit" ? { data: [{ allowed: true }], error: null } : { data: null, error: null },
      ),
    }),
  },
});
mock.module(pathToFileURL("app/lib/auth.ts").href, {
  namedExports: { getAuthenticatedUserId: () => Promise.resolve(USER_ID) },
});

// The provider grant fetch must never fire when the gate rejects first.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("deepgram.com") || url.includes("soniox.com")) {
    providerRequests.push(url);
    return Promise.resolve(new Response(JSON.stringify({ access_token: "dg-grant" }), { status: 200 }));
  }
  return realFetch(input, init);
}) as typeof fetch;

const { POST } = await import("./route.ts");

function tokenRequest(sessionId: string) {
  return new Request("https://lecue.test/api/deepgram-token", {
    method: "POST",
    body: JSON.stringify({ sessionId, language: "ko" }),
  });
}

function grantConsents() {
  outcomes["consents.select"] = { data: [{ consent_type: "age_14" }, { consent_type: "recording" }] };
}

test.beforeEach(() => {
  calls = [];
  outcomes = {};
  providerRequests = [];
});

test("an account without the stored consents cannot mint a token, dialog or no dialog", async () => {
  outcomes["consents.select"] = { data: [{ consent_type: "age_14" }] }; // recording missing
  const response = await POST(tokenRequest(randomUUID()));
  assert.equal(response.status, 403);
  assert.equal(providerRequests.length, 0, "no provider grant may be requested past a failed gate");
  assert.ok(!calls.some((call) => call.table.startsWith("rpc:consume_lecture")), "and nothing is charged");
});

test("a consent read error fails closed", async () => {
  outcomes["consents.select"] = { data: null, error: { code: "500" } };
  const response = await POST(tokenRequest(randomUUID()));
  assert.equal(response.status, 403);
  assert.equal(providerRequests.length, 0);
});

test("an account out of credits is refused before any charge", async () => {
  grantConsents();
  outcomes["rpc:get_credit_status.rpc"] = { data: [{ credits: 0 }] };
  const response = await POST(tokenRequest(randomUUID()));
  assert.equal(response.status, 402);
  assert.ok(!calls.some((call) => call.table === "rpc:consume_lecture_credits"), "the preflight rejection must not charge");
});

test("a consented account with credits gets a token and is charged minute zero", async () => {
  grantConsents();
  outcomes["rpc:get_credit_status.rpc"] = { data: [{ credits: 5 }] };
  outcomes["rpc:consume_lecture_credits.rpc"] = { data: [{ remaining_credits: 4, allowed: true, charged_through: 0 }] };
  const response = await POST(tokenRequest(randomUUID()));
  assert.equal(response.status, 200);
  const body = await response.json() as { accessToken?: string; credits?: number };
  assert.equal(body.accessToken, "dg-grant");
  assert.equal(body.credits, 4);
  const charge = calls.find((call) => call.table === "rpc:consume_lecture_credits");
  assert.equal((charge?.payload as { p_minute_index: number }).p_minute_index, 0);
});
