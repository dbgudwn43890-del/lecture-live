import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
let calls = 0;
mock.module("next/server.js", { namedExports: { NextResponse: Response } });
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => ({ rpc: async () => ({ error: null }) }) } });
mock.module(pathToFileURL("app/lib/storage-cleanup.ts").href, { namedExports: { runStorageCleanup: async () => { calls++; return { claimed: 2, removed: 2, failed: 0 }; } } });
registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); } catch (error) { for (const extension of [".ts", ".js"]) { try { return nextResolve(`${specifier}${extension}`, context); } catch {} } throw error; } } });
const { GET } = await import("./route.ts");
test.beforeEach(() => { process.env.CRON_SECRET = "test-secret"; calls = 0; });
test("cron rejects missing and incorrect credentials without touching storage", async () => {
  for (const authorization of ["", "Bearer wrong-secret", "Bearer test-secrex"]) {
    const result = await GET(new Request("https://lecue.test/api/cron/storage-cleanup", { headers: { authorization } }));
    assert.equal(result.status, 401);
  }
  assert.equal(calls, 0);
});
test("an absent server secret never authenticates a request", async () => {
  delete process.env.CRON_SECRET;
  const result = await GET(new Request("https://lecue.test/api/cron/storage-cleanup", { headers: { authorization: "Bearer " } }));
  assert.equal(result.status, 401);
  assert.equal(calls, 0);
});
test("authorized scheduler performs cleanup and sends a non-cacheable summary", async () => {
  const result = await GET(new Request("https://lecue.test/api/cron/storage-cleanup", { headers: { authorization: "Bearer test-secret" } }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.equal(calls, 1);
});
