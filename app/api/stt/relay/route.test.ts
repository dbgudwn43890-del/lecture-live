import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    for (const extension of [".ts", ".js"]) { try { return nextResolve(`${specifier}${extension}`, context); } catch { /* next */ } }
    throw error;
  }
} });
type Outcome = { data?: unknown; error?: unknown };
let outcome: Outcome;
let adminAvailable: boolean;
let calls: Array<{ name: string; params: Record<string, unknown> }>;
const secret = "internal-relay-test-secret-at-least-32-characters";
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => adminAvailable ? {
  rpc: (name: string, params: Record<string, unknown>) => { calls.push({ name, params }); return Promise.resolve(outcome); },
} : null } });
const { POST } = await import("./route.ts");
function request(body: unknown, authorization: string | null = `Bearer ${secret}`) {
  return new Request("https://lecue.test/api/stt/relay", { method: "POST", headers: authorization ? { Authorization: authorization } : {}, body: JSON.stringify(body) });
}
const connectionId = randomUUID();
const ticket = "t".repeat(43);
test.beforeEach(() => {
  calls = []; adminAvailable = true;
  outcome = { data: { configuration: { provider: "deepgram", listenUrl: "wss://api.deepgram.com/v1/listen" }, authorizedBytes: 1920000, baseBytes: 0, leaseMs: 20000 } };
  process.env.STT_RELAY_SECRET = secret;
  process.env.DEEPGRAM_API_KEY = "deepgram-private-fixture";
  process.env.SONIOX_API_KEY = "soniox-private-fixture";
});

test("unauthenticated requests never reach credentials or DB", async () => {
  for (const authorization of [null, "Bearer wrong", `bearer ${secret}`, `Bearer ${secret.slice(0, -1)}`, `Bearer ${"x".repeat(secret.length)}`]) {
    const response = await POST(request({ action: "open", ticket, connectionId }, authorization));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(JSON.stringify(await response.json()).includes("private-fixture"), false);
  }
  assert.equal(calls.length, 0);
});
test("short or absent configured secret fails closed", async () => {
  for (const value of ["short", ""]) {
    process.env.STT_RELAY_SECRET = value;
    assert.equal((await POST(request({ action: "open", ticket, connectionId }, `Bearer ${value}`))).status, 401);
  }
  assert.equal(calls.length, 0);
});
test("malformed objects, IDs, and oversized body never reach RPC", async () => {
  for (const body of [null, [], {}, { connectionId: "invalid" }, { connectionId, action: "open", ticket: "invalid" }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  for (const body of ["{", "x".repeat(2049)]) {
    assert.equal((await POST(new Request("https://lecue.test/api/stt/relay", { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body }))).status, 400);
  }
  assert.equal(calls.length, 0);
});
test("valid open hashes the ticket and returns credentials only to the authenticated relay", async () => {
  const response = await POST(request({ action: "open", ticket, connectionId }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.providerKey, "deepgram-private-fixture");
  assert.equal(body.authorizedBytes, 1920000);
  assert.deepEqual(calls, [{ name: "open_stt_relay_service", params: { p_token_hash: createHash("sha256").update(ticket).digest("hex"), p_connection_id: connectionId } }]);
});
test("Soniox open selects only the configured provider key", async () => {
  outcome = { data: { configuration: { provider: "soniox" } } };
  const response = await POST(request({ action: "open", ticket, connectionId }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).providerKey, "soniox-private-fixture");
});
test("provider misconfiguration, missing admin, and RPC errors fail closed", async () => {
  delete process.env.DEEPGRAM_API_KEY;
  assert.equal((await POST(request({ action: "open", ticket, connectionId }))).status, 503);
  adminAvailable = false;
  assert.equal((await POST(request({ action: "open", ticket, connectionId }))).status, 503);
  adminAvailable = true;
  outcome = { error: { code: "DB_UNAVAILABLE" } };
  assert.equal((await POST(request({ action: "open", ticket, connectionId }))).status, 503);
  assert.equal((await POST(request({ action: "progress", connectionId, processedBytes: 0 }))).status, 503);
});
test("replayed ticket, empty balance, and expired lease are not successful opens", async () => {
  for (const error of ["INVALID_TICKET", "NO_CREDITS", "LEASE_EXPIRED", "CONNECTION_ACTIVE"]) {
    outcome = { data: { error } };
    const response = await POST(request({ action: "open", ticket, connectionId }));
    assert.equal(response.status, error === "NO_CREDITS" ? 402 : 409);
    assert.equal((await response.json()).providerKey, undefined);
  }
});
test("progress and close pass bounded integer byte counts and explicit booleans", async () => {
  outcome = { data: { authorizedBytes: 1920000, leaseMs: 20000 } };
  assert.equal((await POST(request({ action: "progress", connectionId, processedBytes: 1900000, extend: true }))).status, 200);
  assert.deepEqual(calls.at(-1), { name: "advance_stt_relay_service", params: { p_connection_id: connectionId, p_processed_bytes: 1900000, p_extend: true, p_close: false } });
  outcome = { data: { closed: true } };
  assert.equal((await POST(request({ action: "close", connectionId, processedBytes: 1900000, extend: "true" }))).status, 200);
  assert.deepEqual(calls.at(-1)?.params, { p_connection_id: connectionId, p_processed_bytes: 1900000, p_extend: false, p_close: true });
});
test("invalid byte counts and unknown actions cannot advance accounting", async () => {
  for (const processedBytes of [undefined, null, -1, 0.5, "32000", 345600001, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await POST(request({ action: "progress", connectionId, processedBytes }))).status, 400);
  }
  assert.equal((await POST(request({ action: "other", connectionId, processedBytes: 0 }))).status, 400);
  assert.equal(calls.length, 0);
});
test("missing progress result and expired lease fail closed", async () => {
  outcome = { data: null };
  assert.equal((await POST(request({ action: "progress", connectionId, processedBytes: 0 }))).status, 503);
  outcome = { data: { error: "LEASE_EXPIRED" } };
  assert.equal((await POST(request({ action: "progress", connectionId, processedBytes: 0 }))).status, 409);
});
