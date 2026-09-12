import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { STARTER_CREDITS, STARTER_DAYS } from "./plans.ts";

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    for (const extension of [".ts", ".js"]) {
      try { return nextResolve(`${specifier}${extension}`, context); } catch { /* next extension */ }
    }
    throw error;
  }
} });

const USER_ID = "22222222-2222-4222-8222-222222222222";
let user: Record<string, unknown> | null;
let authError: { code: string } | null;
let authThrows: boolean;
let configured: boolean;
let writes: { values: Record<string, unknown>; options: Record<string, unknown> }[];
let grant: Record<string, unknown> | null;
const admin = {
  auth: { admin: { getUserById: async (id: string) => {
    assert.equal(id, USER_ID);
    if (authThrows) throw new Error("Auth unavailable");
    return { data: { user }, error: authError };
  } } },
  from: (table: string) => {
    assert.equal(table, "credit_grants");
    return { upsert: async (values: Record<string, unknown>, options: Record<string, unknown>) => {
      writes.push({ values, options });
      if (!grant || !options.ignoreDuplicates) grant = { ...values };
      return { error: null };
    } };
  },
};
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => configured ? admin : null } });
const { ensureFreePilotGrant } = await import("./free-pilot.ts");

test.beforeEach(() => {
  user = { id: USER_ID, email: "learner@example.test", email_confirmed_at: "2026-09-07T00:00:00Z" };
  authError = null; authThrows = false; configured = true; writes = []; grant = null;
});

test("pending, anonymous and metadata-only accounts receive no starter credits", async () => {
  for (const candidate of [
    null,
    { id: USER_ID, email: "learner@example.test" },
    { id: USER_ID, email: "learner@example.test", user_metadata: { email_verified: true } },
    { ...user, is_anonymous: true },
    { ...user, id: "someone-else" },
  ]) {
    user = candidate;
    assert.equal(await ensureFreePilotGrant(USER_ID), false);
  }
  assert.equal(writes.length, 0);
});

test("an unavailable or failed Auth read cannot reach the credit write", async () => {
  authError = { code: "auth-failed" };
  assert.equal(await ensureFreePilotGrant(USER_ID), false);
  authError = null;
  authThrows = true;
  assert.equal(await ensureFreePilotGrant(USER_ID), false);
  authThrows = false;
  configured = false;
  assert.equal(await ensureFreePilotGrant(USER_ID), false);
  assert.equal(writes.length, 0);
});

test("confirmed Google and password accounts receive the configured starter credits", async () => {
  for (const provider of ["google", "email"]) {
    user = { ...user, app_metadata: { provider } };
    assert.equal(await ensureFreePilotGrant(USER_ID), true);
    assert.equal(writes.at(-1)?.values.granted_credits, STARTER_CREDITS);
    const issued = writes.at(-1)!.values;
    assert.equal(issued.source_type, "trial", "the card-free grant does not depend on a payment");
    assert.equal(Date.parse(String(issued.expires_at)) - Date.parse(String(issued.starts_at)), STARTER_DAYS * 86_400_000, "the advertised validity starts when credits are issued");
    assert.equal(writes.at(-1)?.values.source_id, USER_ID);
    assert.deepEqual(writes.at(-1)?.options, { onConflict: "source_type,source_id", ignoreDuplicates: true });
  }
});

test("a repeated first-load request does not reset a previously spent grant", async () => {
  assert.equal(await ensureFreePilotGrant(USER_ID), true);
  grant!.remaining_credits = 17;
  const originalExpiry = grant!.expires_at;
  assert.equal(await ensureFreePilotGrant(USER_ID), true);
  assert.equal(grant!.remaining_credits, 17);
  assert.equal(grant!.expires_at, originalExpiry);
});
