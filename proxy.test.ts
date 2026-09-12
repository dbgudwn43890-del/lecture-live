import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";

import { getOAuthFallbackNext, getSafeAuthNext, localePathFor } from "./app/lib/auth-redirect.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      for (const extension of [".ts", ".js"]) {
        try { return nextResolve(`${specifier}${extension}`, context); } catch { /* next extension */ }
      }
      throw error;
    }
  },
});

let authCalls = 0;
mock.module("@supabase/ssr", {
  namedExports: {
    createServerClient: () => {
      authCalls++;
      return { auth: { getClaims: async () => ({ data: { claims: null } }) } };
    },
  },
});
const { NextRequest } = await import("next/server");
const { proxy } = await import("./proxy.ts");

test.beforeEach(() => { authCalls = 0; });

test("phone microphone reads need no account and preserve the QR's UI language", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await proxy(new NextRequest("https://www.lecue.app/phone-mic?locale=ko", { method }));
    assert.equal(response.headers.get("x-middleware-next"), "1");
    assert.equal(response.headers.get("x-middleware-request-x-site-locale"), "ko");
  }
  assert.equal(authCalls, 0);
  for (const path of ["/phone-mic-extra", "/phone-mic/private"]) {
    const response = await proxy(new NextRequest(`https://www.lecue.app${path}`));
    assert.equal(new URL(response.headers.get("location")!).pathname, "/login");
  }
  const response = await proxy(new NextRequest("https://www.lecue.app/phone-mic", { method: "POST" }));
  assert.equal(new URL(response.headers.get("location")!).pathname, "/login");
});

test("serves only read requests for the versioned PDF worker without authentication or locale redirects", async () => {
  for (const method of ["GET", "HEAD"]) {
    const request = new NextRequest("https://www.lecue.app/pdfjs/6.3.289/pdf.worker.min.mjs?lang=en", { method });
    const response = await proxy(request);
    assert.equal(response.headers.get("x-middleware-next"), "1");
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(authCalls, 0);
});

test("the worker exception does not expose other files, path prefixes, or uploaded documents", async () => {
  const protectedPaths = [
    "/pdfjs",
    "/pdfjs/6.3.289/pdf.worker.min.mjs.map",
    "/pdfjs/6.3.289/pdf.worker.min.mjs/extra",
    "/pdfjs/6.3.289/pdf.worker.min.mjs.pdf",
    "/pdfjs/6.3.289/%70df.worker.min.mjs",
    "/pdfjs/latest/pdf.worker.min.mjs",
    "/pdfjs/6.3.289/private-lecture.pdf",
    "/pdfjs-extra/6.3.289/pdf.worker.min.mjs",
    "/materials/private-lecture.pdf",
    "/classroom",
  ];
  for (const path of protectedPaths) {
    const response = await proxy(new NextRequest(`https://www.lecue.app${path}`, {
      headers: { "accept-language": "ko" },
    }));
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.pathname, "/login", path);
    assert.equal(location.searchParams.get("next"), path, path);
  }
  assert.equal(authCalls, protectedPaths.length);
});

test("a write request to the worker path still takes the normal authentication path", async () => {
  const path = "/pdfjs/6.3.289/pdf.worker.min.mjs";
  const response = await proxy(new NextRequest(`https://www.lecue.app${path}`, { method: "POST" }));
  assert.equal(new URL(response.headers.get("location")!).pathname, "/login");
  assert.equal(authCalls, 1);
});

test("material API requests retain their locale header and route-level authentication flow", async () => {
  const response = await proxy(new NextRequest("https://www.lecue.app/api/materials?documentId=private-document", {
    headers: { "x-site-locale": "en" },
  }));
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.equal(response.headers.get("x-middleware-request-x-site-locale"), "en");
  assert.equal(response.headers.get("x-middleware-request-x-site-path"), "/api/materials");
  assert.equal(authCalls, 0);
});

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
  assert.equal(localePathFor("/en", false), "/");
  assert.equal(localePathFor("/stt-lab", true), null);
  assert.equal(localePathFor("/api/ask", true), null);
  // A path that merely starts with the letters "en" is not an English page.
  assert.equal(localePathFor("/enrollment", false), null);
});
