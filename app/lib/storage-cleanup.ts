import type { SupabaseClient } from "@supabase/supabase-js";

type Deletion = {
  bucket: "materials" | "lecture-audio";
  objectKey: string;
  userId: string;
  reason: string;
  notBefore?: string;
};

/** Persist before discarding a path; Storage failures remain retryable. */
export async function enqueueStorageDeletion(admin: SupabaseClient, deletion: Deletion) {
  const { error } = await admin.rpc("enqueue_storage_deletion", {
    p_bucket: deletion.bucket,
    p_object_key: deletion.objectKey,
    p_user_id: deletion.userId,
    p_reason: deletion.reason,
    ...(deletion.notBefore ? { p_not_before: deletion.notBefore } : {}),
  });
  if (error) throw new Error("Could not persist storage deletion");
}

/** Leases prevent concurrent workers from racing a retry. Missing objects are safe to remove again. */
export async function drainStorageDeletions(admin: SupabaseClient, options: { limit?: number; userId?: string } = {}) {
  const { data, error } = await admin.rpc("claim_storage_deletions", {
    p_limit: options.limit ?? 50,
    p_user_id: options.userId ?? null,
  });
  if (error) throw new Error("Could not claim storage deletions");
  const jobs = (data ?? []) as { id: string; bucket: string; object_key: string; claim_token: string }[];
  let removed = 0;
  let failed = 0;
  for (const job of jobs) {
    let failure: string | null = null;
    try {
      const result = await admin.storage.from(job.bucket).remove([job.object_key]);
      if (result.error) failure = "storage_remove_failed";
    } catch {
      failure = "storage_remove_failed";
    }
    const { data: finished, error: finishError } = await admin.rpc("finish_storage_deletion", {
      p_id: job.id, p_token: job.claim_token, p_error: failure,
    });
    // A failed DB acknowledgement leaves the lease/path intact for another run.
    if (failure || finishError || !finished) failed += 1;
    else removed += 1;
  }
  return { claimed: jobs.length, removed, failed };
}

export async function runStorageCleanup(admin: SupabaseClient) {
  const { error } = await admin.rpc("schedule_storage_cleanup");
  if (error) throw new Error("Could not schedule storage cleanup");
  return drainStorageDeletions(admin);
}
