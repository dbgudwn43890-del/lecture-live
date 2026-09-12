import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { drainStorageDeletions, enqueueStorageDeletion, runStorageCleanup } from "./storage-cleanup.ts";

function fixture(options: { storageFails?: boolean; throws?: boolean; finishFails?: boolean; scheduleFails?: boolean } = {}) {
  const calls: { name: string; params?: Record<string, unknown> }[] = [];
  const admin = {
    rpc: async (name: string, params?: Record<string, unknown>) => {
      calls.push({ name, params });
      if (name === "claim_storage_deletions") return { data: [{ id: "job", bucket: "lecture-audio", object_key: "owner/audio.wav", claim_token: "lease" }], error: null };
      if (name === "finish_storage_deletion") return { data: !params?.p_error, error: options.finishFails ? {} : null };
      return { data: null, error: options.scheduleFails ? {} : null };
    },
    storage: { from: (bucket: string) => ({ remove: async (paths: string[]) => {
      calls.push({ name: "storage.remove", params: { bucket, paths } });
      if (options.throws) throw new Error("private provider detail");
      return { error: options.storageFails ? { message: "private provider detail" } : null };
    } }) },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

test("successful removal acknowledges the matching lease only after Storage succeeds", async () => {
  const { admin, calls } = fixture();
  assert.deepEqual(await drainStorageDeletions(admin, { userId: "owner", limit: 3 }), { claimed: 1, removed: 1, failed: 0 });
  assert.deepEqual(calls.map(call => call.name), ["claim_storage_deletions", "storage.remove", "finish_storage_deletion"]);
  assert.deepEqual(calls[2].params, { p_id: "job", p_token: "lease", p_error: null });
  assert.deepEqual(calls[0].params, { p_user_id: "owner", p_limit: 3 });
});
for (const failure of ["storageFails", "throws"] as const) test(`${failure} preserves a retry instead of acknowledging deletion`, async () => {
  const { admin, calls } = fixture({ [failure]: true });
  assert.deepEqual(await drainStorageDeletions(admin), { claimed: 1, removed: 0, failed: 1 });
  assert.equal(calls[2].params?.p_error, "storage_remove_failed");
  assert.doesNotMatch(JSON.stringify(calls), /private provider detail/);
});
test("DB acknowledgement failure remains failed for the next lease", async () => {
  const { admin } = fixture({ finishFails: true });
  assert.deepEqual(await drainStorageDeletions(admin), { claimed: 1, removed: 0, failed: 1 });
});
test("queue failure is surfaced before callers discard their object path", async () => {
  const { admin } = fixture({ scheduleFails: true });
  await assert.rejects(enqueueStorageDeletion(admin, { bucket: "materials", objectKey: "owner/a.pdf", userId: "owner", reason: "save_failed" }), /persist storage deletion/);
});
test("scheduled cleanup discovers expired and orphan paths before draining", async () => {
  const { admin, calls } = fixture();
  await runStorageCleanup(admin);
  assert.equal(calls[0].name, "schedule_storage_cleanup");
});
