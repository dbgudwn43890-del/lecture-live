type Bucket = {
  count: number;
  resetAt: number;
};

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

const globalRateLimits = globalThis as typeof globalThis & {
  lectureLiveRateLimits?: Map<string, Bucket>;
};

const buckets = (globalRateLimits.lectureLiveRateLimits ??= new Map());
const MAX_BUCKETS = 10_000;

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  let bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size >= MAX_BUCKETS) {
      for (const [storedKey, storedBucket] of buckets) {
        if (storedBucket.resetAt <= now) buckets.delete(storedKey);
      }
      if (buckets.size >= MAX_BUCKETS) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1_000)),
        };
      }
    }

    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  if (bucket.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    remaining: limit - bucket.count,
    retryAfterSeconds: 0,
  };
}

/**
 * Shared-store rate limit for the routes that spend real money on a provider
 * key. The in-process limiter above only bounds a single serverless instance,
 * so a caller fanning out across instances multiplies every limit by the
 * instance count. This one counts in Postgres, where all instances agree.
 *
 * Falls back to the in-process limiter when the admin client is unavailable,
 * so a missing service key degrades the limit rather than removing it.
 */
export async function checkSharedRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  // Imported lazily so the in-process limiter above stays dependency-free for
  // the node --test runner, which cannot resolve extensionless module paths.
  const { createAdminClient } = await import("./supabase/admin");
  const admin = createAdminClient();
  if (!admin) return checkRateLimit(key, limit, windowMs);

  const { data, error } = await admin.rpc("consume_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: Math.max(1, Math.round(windowMs / 1_000)),
  });
  if (error) {
    console.error("Shared rate limit failed", error.code);
    return checkRateLimit(key, limit, windowMs);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const allowed = Boolean(row?.allowed);
  return {
    allowed,
    remaining: 0,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Number(row?.retry_after_seconds ?? 60)),
  };
}
