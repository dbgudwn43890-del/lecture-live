import assert from "node:assert/strict";

import { checkRateLimit } from "../app/lib/rate-limit.ts";

const scope = `self-test-${Date.now()}`;

assert.deepEqual(checkRateLimit(scope, 2, 1_000, 0), {
  allowed: true,
  remaining: 1,
  retryAfterSeconds: 0,
});
assert.equal(checkRateLimit(scope, 2, 1_000, 100).allowed, true);
assert.deepEqual(checkRateLimit(scope, 2, 1_000, 200), {
  allowed: false,
  remaining: 0,
  retryAfterSeconds: 1,
});
assert.equal(checkRateLimit(scope, 2, 1_000, 1_000).allowed, true);

console.log("rate limit self-test passed");
