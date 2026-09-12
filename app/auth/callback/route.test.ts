import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

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

let authError: Error | null = null;
let verifiedTypes: string[] = [];
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, {
  namedExports: {
    createClient: () => ({
      auth: {
        exchangeCodeForSession: async () => ({ error: authError }),
        verifyOtp: async ({ type }: { type: string }) => { verifiedTypes.push(type); return { error: authError }; },
      },
    }),
  },
});

const { NextRequest } = await import("next/server");
const { GET } = await import("./route.ts");

test.beforeEach(() => { authError = null; verifiedTypes = []; });

async function destination(next: string) {
  const url = new URL("https://www.lecue.app/auth/callback");
  url.searchParams.set("code", "one-time-auth-code");
  url.searchParams.set("next", next);
  const response = await GET(new NextRequest(url));
  return new URL(response.headers.get("location")!);
}

test("sign-in preserves the lecture or plan query on both language routes", async () => {
  for (const path of [
    "/classroom?session=lecture-id",
    "/en/classroom?classroom=course-id&session=lecture-id",
    "/en/classroom?session=lecture-id&lang=ko",
    "/billing?plan=monthly",
    "/en/billing?plan=semester",
  ]) {
    assert.equal((await destination(path)).href, `https://www.lecue.app${path}`);
  }
});

test("a failed sign-in keeps the safe destination for another attempt", async () => {
  authError = new Error("Expired code");
  for (const next of ["/classroom?session=lecture-id", "/en/billing?plan=monthly"]) {
    const url = await destination(next);
    assert.equal(url.pathname, next.startsWith("/en/") ? "/en/login" : "/login");
    assert.equal(url.searchParams.get("error"), "callback");
    assert.equal(url.searchParams.get("next"), next);
    assert.equal(url.searchParams.has("code"), false);
  }
});

test("the callback does not redirect to an external or unapproved destination", async () => {
  for (const path of ["https://example.com/classroom", "//example.com/classroom", "/admin"]) {
    assert.equal((await destination(path)).href, "https://www.lecue.app/classroom");
  }
});

test("signup email links accept only the supported confirmation types", async () => {
  for (const type of ["signup", "email", "sms", "email_change", "unknown"]) {
    const response = await GET(new NextRequest(`https://www.lecue.app/auth/callback?token_hash=example-hash&type=${type}`));
    const target = new URL(response.headers.get("location")!);
    assert.equal(target.pathname, type === "signup" || type === "email" ? "/classroom" : "/login");
  }
  assert.deepEqual(verifiedTypes, ["signup", "email"]);
});

test("recovery links lead to password reset without minting a classroom session or forwarding secrets", async () => {
  const response = await GET(new NextRequest("https://www.lecue.app/auth/callback?token_hash=private-token&type=recovery&next=%2Fen%2Fbilling%3Fplan%3Dmonthly"));
  const target = new URL(response.headers.get("location")!);
  assert.equal(target.pathname, "/en/login");
  assert.equal(target.searchParams.get("mode"), "recovery");
  assert.equal(target.searchParams.get("next"), "/en/billing?plan=monthly");
  assert.equal(target.searchParams.has("token_hash"), false);
  assert.deepEqual(verifiedTypes, []);
});
