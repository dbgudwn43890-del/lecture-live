import assert from "node:assert/strict";
import test from "node:test";
import { preferredSiteLocale, languageSwitchUrl } from "./site-locale.ts";
test("manual choice overrides location and browser; country defaults apply to new visitors", () => {
  assert.equal(preferredSiteLocale("ko", "US", "en", "/en"), "ko");
  assert.equal(preferredSiteLocale("en", "KR", "ko", "/"), "en");
  assert.equal(preferredSiteLocale(undefined, "US", "ko", "/"), "en");
  assert.equal(preferredSiteLocale(undefined, "KR", "en", "/"), "ko");
});
test("missing country uses weighted browser preference and ignores invalid stored choices", () => {
  assert.equal(preferredSiteLocale("invalid", null, "en-US,en;q=0.9,ko;q=0.8", "/"), "en");
  assert.equal(preferredSiteLocale(undefined, "XX", "en;q=0,ko;q=1", "/en"), "ko");
  assert.equal(preferredSiteLocale(undefined, null, "", "/en"), "en");
});
test("switching language preserves the selected session and anchor", () => {
  assert.equal(languageSwitchUrl("http://localhost:3000/en/classroom?session=abc#question", "ko"), "/en/classroom?session=abc&lang=ko#question");
});
