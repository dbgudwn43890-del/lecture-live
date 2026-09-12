import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    for (const extension of [".ts", ".js"]) {
      try { return nextResolve(`${specifier}${extension}`, context); } catch { /* next extension */ }
    }
    throw error;
  }
} });

let user: Record<string, unknown> | null;
let authError: { message: string } | null;
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, {
  namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: authError }) } }) },
});
const { getAuthenticatedUserId } = await import("./auth.ts");

test.beforeEach(() => { user = null; authError = null; });

test("common API authentication rejects unverified sessions and Auth read errors", async () => {
  for (const candidate of [null, { id: "learner", email: "learner@example.test" }, {
    id: "learner", email: "learner@example.test", user_metadata: { email_verified: true },
  }]) {
    user = candidate;
    assert.equal(await getAuthenticatedUserId(), null);
  }
  user = { id: "learner", email: "learner@example.test", email_confirmed_at: "2026-09-07T00:00:00Z" };
  authError = { message: "Auth unavailable" };
  assert.equal(await getAuthenticatedUserId(), null);
});

test("common authentication preserves confirmed Google and password sign-in", async () => {
  for (const provider of ["google", "email"]) {
    user = { id: "learner", email: "learner@example.test", email_confirmed_at: "2026-09-07T00:00:00Z", app_metadata: { provider } };
    assert.equal(await getAuthenticatedUserId(), "learner");
  }
});
