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

// Regression: the live Google tag selected analytics.google.com/g/collect,
// which is a different origin from google-analytics.com.
test("analytics frame permits the observed GA4 collector without audience endpoints", async () => {
  const rules = await config.headers!();
  const policy = rules.find(rule => rule.source === "/api/analytics/frame")!.headers
    .find(header => header.key === "Content-Security-Policy")!.value;
  const directives = new Map(policy.split(";").map(value => {
    const [name, ...sources] = value.trim().split(/\s+/);
    return [name, sources];
  }));
  for (const name of ["connect-src", "img-src"]) {
    assert.ok(directives.get(name)!.includes("https://analytics.google.com/g/collect"));
    assert.ok(directives.get(name)!.every(source => !source.includes("*") && !source.includes("doubleclick") && !source.includes("google.co.kr") && !source.includes("www.google.com")));
  }
});
