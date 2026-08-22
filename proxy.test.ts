import assert from "node:assert/strict";
import test from "node:test";

import { getOAuthFallbackNext } from "./app/lib/auth-redirect.ts";

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
