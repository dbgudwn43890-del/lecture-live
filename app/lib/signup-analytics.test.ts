import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsSignupAnalytics, claimSignupAnalytics, finalizeSignupAnalytics,
  isSameOriginAnalyticsRequest, isSignupAnalyticsEnabled,
} from "./signup-analytics.ts";

test("measurement requires a valid ID and explicit consent", () => {
  for (const value of [undefined, "", "granted-no", "denied", "true"]) assert.equal(allowsSignupAnalytics(value), false);
  assert.equal(allowsSignupAnalytics("granted"), true);
  assert.equal(isSignupAnalyticsEnabled("G-ABC1234567"), true);
  for (const value of [undefined, "", "G-", "AW-123456", "G-ABC123<script>"]) assert.equal(isSignupAnalyticsEnabled(value), false);
});

test("signup claim requests require same-origin browser requests", () => {
  const url = "https://www.lecue.app/api/analytics/signup";
  assert.equal(isSameOriginAnalyticsRequest(new Request(url, { headers: { origin: "https://www.lecue.app", "sec-fetch-site": "same-origin" } })), true);
  assert.equal(isSameOriginAnalyticsRequest(new Request(url)), false);
  assert.equal(isSameOriginAnalyticsRequest(new Request(url, { headers: { origin: "https://attacker.test" } })), false);
  assert.equal(isSameOriginAnalyticsRequest(new Request(url, { headers: { origin: "https://www.lecue.app", "sec-fetch-site": "cross-site" } })), false);
});

test("callback finalizes a DB marker, never a timestamp or user-supplied ID", async () => {
  const calls: unknown[] = [];
  const db = { rpc: (name: string, args?: Record<string, unknown>) => { calls.push({ name, args }); return Promise.resolve({ data: null, error: null }); } };
  assert.equal(await finalizeSignupAnalytics(db, "granted", "G-ABC1234567"), true);
  assert.deepEqual(calls, [{ name: "finalize_signup_analytics", args: { p_allowed: true } }]);
  await finalizeSignupAnalytics(db, "denied", "G-ABC1234567");
  await finalizeSignupAnalytics(db, "granted", undefined);
  assert.deepEqual(calls.slice(1), [
    { name: "finalize_signup_analytics", args: { p_allowed: false } },
    { name: "finalize_signup_analytics", args: { p_allowed: false } },
  ]);
});

test("optional measurement failure cannot throw out of the auth callback", async () => {
  assert.equal(await finalizeSignupAnalytics({ rpc: async () => { throw new Error("offline"); } }, "granted", "G-ABC1234567"), false);
  assert.equal(await finalizeSignupAnalytics({ rpc: async () => ({ data: null, error: { code: "PGRST202" } }) }, "granted", "G-ABC1234567"), false);
});

test("only one valid server-owned marker is eligible; no identifiers escape", async () => {
  assert.deepEqual(await claimSignupAnalytics({ rpc: async () => ({ data: [{ method: "google", user_id: "must-not-leave-server" }], error: null }) }), { eligible: true, method: "google" });
  for (const data of [null, [], [{ method: "bad" }], [{ method: "google" }, { method: "google" }]]) {
    assert.deepEqual(await claimSignupAnalytics({ rpc: async () => ({ data, error: null }) }), { eligible: false });
  }
  await assert.rejects(claimSignupAnalytics({ rpc: async () => ({ data: null, error: { code: "PGRST202" } }) }));
});
