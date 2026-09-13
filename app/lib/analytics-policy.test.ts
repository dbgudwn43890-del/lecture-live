import test from "node:test";
import assert from "node:assert/strict";
import { safeAnalyticsLocation, analyticsEnabled } from "./analytics-policy.ts";

test("Google gets only fixed paths and approved campaign/click fields", () => {
  const result = safeAnalyticsLocation("https://www.lecue.app/en/classroom?session=private-account&question=secret&code=auth&email=a@example.com&utm_campaign=private&utm_source=youtube&gclid=AbCdEfGhIj12345#transcript");
  assert.equal(result, "https://www.lecue.app/en/classroom?utm_source=youtube&gclid=AbCdEfGhIj12345");
  assert.equal(safeAnalyticsLocation("https://evil.test/private/person@example.com?token_hash=secret"), "https://www.lecue.app/other");
  assert.equal(safeAnalyticsLocation("/auth/callback?code=secret&gclid=person@example.com"), "https://www.lecue.app/other");
});
test("unset and malformed measurement IDs keep collection disabled", () => {
  for (const id of [undefined, "", "G-test<script>", "AW-123"]) assert.equal(analyticsEnabled(id), false);
  assert.equal(analyticsEnabled("G-ABCDEF1234"), true);
});
