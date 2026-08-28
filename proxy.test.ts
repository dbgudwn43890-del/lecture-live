import assert from "node:assert/strict";
import test from "node:test";

import { getOAuthFallbackNext, getSafeAuthNext, localePathFor } from "./app/lib/auth-redirect.ts";

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

test("an explicit language choice outranks the IP guess", async () => {
  // A Korean speaker abroad picked Korean; the US IP must not override it.
  assert.equal(getOAuthFallbackNext("/", "US", true, false), "/classroom");
  // And someone in Korea who picked English keeps English.
  assert.equal(getOAuthFallbackNext("/", "KR", true, true), "/en/classroom");
});

test("keeps only approved post-auth destinations", () => {
  assert.equal(getSafeAuthNext("/billing?plan=monthly"), "/billing?plan=monthly");
  assert.equal(getSafeAuthNext("/classrooms"), "/classroom");
  assert.equal(getSafeAuthNext("/en/billing?plan=semester", "/en/classroom"), "/en/billing?plan=semester");
  assert.equal(getSafeAuthNext("/en/classrooms", "/en/classroom"), "/en/classroom");
  assert.equal(getSafeAuthNext("https://attacker.example", "/classroom"), "/classroom");
  assert.equal(getSafeAuthNext("//attacker.example", "/classroom"), "/classroom");
});

test("sends a Korean visitor to the Korean twin of an English page", () => {
  // Switching back to Korean used to set the cookie and leave the visitor on
  // the English page, because only the /en direction was enforced.
  assert.equal(localePathFor("/en/classroom", false), "/classroom");
  assert.equal(localePathFor("/en/billing", false), "/billing");
  assert.equal(localePathFor("/classroom", true), "/en/classroom");
});

test("leaves a page that is already in the right language alone", () => {
  assert.equal(localePathFor("/classroom", false), null);
  assert.equal(localePathFor("/en/classroom", true), null);
});

test("moves only the pages that exist in both languages", () => {
  // The landing page renders either language at "/", so it is never moved.
  assert.equal(localePathFor("/", true), null);
  assert.equal(localePathFor("/en", false), null);
  assert.equal(localePathFor("/stt-lab", true), null);
  assert.equal(localePathFor("/api/ask", true), null);
  // A path that merely starts with the letters "en" is not an English page.
  assert.equal(localePathFor("/enrollment", false), null);
});
