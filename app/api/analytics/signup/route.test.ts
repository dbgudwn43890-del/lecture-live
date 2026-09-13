import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    for (const extension of [".ts", ".js"]) {
      try { return nextResolve(`${specifier}${extension}`, context); } catch { /* try next */ }
    }
    throw error;
  }
} });

let signedIn = true;
let data: unknown = [{ method: "google" }];
let rpcError: { code: string } | null = null;
let createCalls = 0;
let rpcCalls: unknown[] = [];
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, { namedExports: {
  createClient: async () => {
    createCalls += 1;
    return {
      auth: { getUser: async () => ({ data: { user: signedIn ? { id: "server-user" } : null }, error: null }) },
      rpc: async (name: string, args?: unknown) => { rpcCalls.push({ name, args }); return { data, error: rpcError }; },
    };
  },
} });
const { NextRequest } = await import("next/server");
const { POST } = await import("./route.ts");
const { POST: FINALIZE } = await import("./finalize/route.ts");
const url = "https://www.lecue.app/api/analytics/signup";
function request(consent = "granted", origin = "https://www.lecue.app", body?: string) {
  return new NextRequest(url, { method: "POST", headers: { origin, cookie: `lecue-analytics-consent=${consent}`, "sec-fetch-site": "same-origin" }, body });
}
test.beforeEach(() => {
  signedIn = true; data = [{ method: "google" }]; rpcError = null;
  createCalls = 0; rpcCalls = [];
  process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABC1234567";
});

test("disabled or denied tracking does not touch auth or consume a marker", async () => {
  const denied = await POST(request("denied"));
  assert.deepEqual(await denied.json(), { eligible: false });
  delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  assert.deepEqual(await (await POST(request())).json(), { eligible: false });
  assert.equal(createCalls, 0);
});
test("cross-origin requests cannot consume a conversion", async () => {
  const response = await POST(request("granted", "https://attacker.test"));
  assert.equal(response.status, 403);
  assert.equal(createCalls, 0);
});
test("no session means no signup", async () => {
  signedIn = false;
  assert.deepEqual(await (await POST(request())).json(), { eligible: false });
  assert.equal(rpcCalls.length, 0);
});
test("claims only current authenticated account; ignores supplied identifiers", async () => {
  const response = await POST(request("granted", "https://www.lecue.app", JSON.stringify({ user_id: "other-user", is_new_user: true })));
  assert.deepEqual(await response.json(), { eligible: true, method: "google" });
  assert.deepEqual(rpcCalls, [{ name: "claim_signup_analytics", args: undefined }]);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});
test("existing login/no pending marker is not a signup", async () => {
  data = [];
  assert.deepEqual(await (await POST(request())).json(), { eligible: false });
});
test("database failure is fail-closed for tracking", async () => {
  rpcError = { code: "PGRST202" };
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { eligible: false });
});

test("confirmed email flow finalizes using server consent, not supplied user data", async () => {
  const response = await FINALIZE(request());
  assert.equal(response.status, 200);
  assert.deepEqual(rpcCalls, [{ name: "finalize_signup_analytics", args: { p_allowed: true } }]);
});
test("email opt-out is finalized as discarded to prevent later login misclassification", async () => {
  const response = await FINALIZE(request("denied"));
  assert.equal(response.status, 200);
  assert.deepEqual(rpcCalls, [{ name: "finalize_signup_analytics", args: { p_allowed: false } }]);
});
test("email finalize cannot be called cross-origin or without an authenticated session", async () => {
  assert.equal((await FINALIZE(request("granted", "https://attacker.test"))).status, 403);
  signedIn = false;
  assert.equal((await FINALIZE(request())).status, 401);
  assert.equal(rpcCalls.length, 0);
});
test("missing optional signup migration returns a non-identifying failure", async () => {
  rpcError = { code: "PGRST202" };
  const response = await FINALIZE(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false });
});
