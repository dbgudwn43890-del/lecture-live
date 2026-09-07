import assert from "node:assert/strict";
import test from "node:test";
import { INDEXABLE_PATHS, pageSearchMetadata, publicPagePair } from "./site-seo.ts";

test("public pages have self canonicals and reciprocal language alternatives", () => {
  for (const path of INDEXABLE_PATHS) {
    const locale = path.startsWith("/en") ? "en" : "ko";
    const metadata = pageSearchMetadata(path, locale);
    assert.equal(metadata.alternates?.canonical, `https://www.lecue.app${path}`);
    const pair = publicPagePair(path)!;
    assert.deepEqual(publicPagePair(pair.ko), publicPagePair(pair.en));
    assert.equal(metadata.robots.index, true);
  }
});

test("adaptive homepage points to stable language URLs", () => {
  assert.equal(pageSearchMetadata("/", "ko").alternates?.canonical, "https://www.lecue.app/ko");
  assert.equal(pageSearchMetadata("/", "en").alternates?.canonical, "https://www.lecue.app/en");
});

test("login and private routes are excluded instead of canonicalized to home", () => {
  for (const path of ["/login", "/en/login", "/classroom", "/admin", "/unknown"]) {
    assert.equal(publicPagePair(path), null);
    assert.equal(pageSearchMetadata(path, "en").robots.index, false);
    assert.equal(pageSearchMetadata(path, "en").alternates, undefined);
    assert.equal(INDEXABLE_PATHS.includes(path), false);
  }
});
