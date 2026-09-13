import test from "node:test";
import assert from "node:assert/strict";
import config from "../../next.config.ts";

test("analytics frame can load in its own origin while product pages reject framing", async () => {
  const rules = await config.headers!();
  function headers(path: string) {
    const result = new Map<string, string>();
    for (const rule of rules) {
      if (rule.source === "/:path*" || rule.source === path) {
        for (const header of rule.headers) result.set(header.key, header.value);
      }
    }
    return result;
  }
  const frame = headers("/api/analytics/frame");
  assert.equal(frame.get("X-Frame-Options"), "SAMEORIGIN");
  assert.match(frame.get("Content-Security-Policy")!, /frame-ancestors 'self';/);
  assert.equal(frame.get("Referrer-Policy"), "no-referrer");
  for (const path of ["/en", "/en/login", "/en/classroom"]) {
    assert.equal(headers(path).get("X-Frame-Options"), "DENY");
    assert.match(headers(path).get("Content-Security-Policy")!, /frame-ancestors 'none';/);
  }
});
