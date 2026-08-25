import assert from "node:assert/strict";
import test from "node:test";

import { getOAuthFallbackNext, getSafeAuthNext } from "./app/lib/auth-redirect.ts";

test("recovers an OAuth code that Supabase sends to the landing page", async () => {
  assert.equal(getOAuthFallbackNext("/", null, true), "/classroom");
});

test("keeps the English classroom destination for an overseas visitor", async () => {
  assert.equal(getOAuthFallbackNext("/", "US", true), "/en/classroom");
  assert.equal(getOAuthFallbackNext("/en", "KR", true), "/en/classroom");
});

test("does not intercept a normal landing page request", async () => {
  assert.equal(getOAuthFallbackNext("/", null, false), null);
});

test("keeps only approved post-auth destinations", () => {
  assert.equal(getSafeAuthNext("/billing?plan=monthly"), "/billing?plan=monthly");
  assert.equal(getSafeAuthNext("/classrooms"), "/classrooms");
  assert.equal(getSafeAuthNext("/en/billing?plan=semester", "/en/classroom"), "/en/billing?plan=semester");
  assert.equal(getSafeAuthNext("/en/classrooms", "/en/classroom"), "/en/classrooms");
  assert.equal(getSafeAuthNext("https://attacker.example", "/classroom"), "/classroom");
  assert.equal(getSafeAuthNext("//attacker.example", "/classroom"), "/classroom");
});
