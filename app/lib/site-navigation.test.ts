import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { languageSwitchUrl } from "./site-locale.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      for (const extension of [".ts", ".js"]) {
        try { return nextResolve(`${specifier}${extension}`, context); } catch { /* next extension */ }
      }
      throw error;
    }
  },
});

let signedIn = true;
mock.module("@supabase/ssr", {
  namedExports: {
    createServerClient: () => ({ auth: { getClaims: async () => ({ data: { claims: signedIn ? { sub: "test-learner" } : null } }) } }),
  },
});
const { NextRequest } = await import("next/server");
const { proxy } = await import("../../proxy.ts");

test.beforeEach(() => { signedIn = true; });

async function navigate(href: string, choice: "ko" | "en") {
  let url = new URL(href, "https://www.lecue.app");
  for (let step = 0; step < 5; step++) {
    const response = await proxy(new NextRequest(url, { headers: { cookie: `site-locale-choice=${choice}` } }));
    const selected = response.cookies.get("site-locale-choice")?.value;
    if (selected === "ko" || selected === "en") choice = selected;
    const location = response.headers.get("location");
    if (!location) return { url, choice, locale: response.headers.get("x-middleware-request-x-site-locale") };
    url = new URL(location);
  }
  throw new Error("Language navigation did not settle");
}

test("a public-page classroom CTA preserves its visible language over the opposite stored choice", async () => {
  for (const locale of ["ko", "en"] as const) {
    const path = locale === "en" ? "/en/classroom" : "/classroom";
    const result = await navigate(languageSwitchUrl(path, locale), locale === "en" ? "ko" : "en");
    assert.equal(result.url.pathname, path);
    assert.equal(result.url.search, "");
    assert.equal(result.locale, locale);
    assert.equal(result.choice, locale);
  }
});

test("signed-out classroom and plan entry retain their language and destination at login", async () => {
  signedIn = false;
  for (const locale of ["ko", "en"] as const) {
    const base = locale === "en" ? "/en" : "";
    const choice = locale === "en" ? "ko" : "en";
    const classroom = await navigate(languageSwitchUrl(`${base}/classroom`, locale), choice);
    assert.equal(classroom.url.pathname, `${base}/login`);
    assert.equal(classroom.url.searchParams.get("next"), `${base}/classroom`);
    assert.equal(classroom.locale, locale);
    const next = `${base}/billing?plan=semester`;
    const plan = await navigate(languageSwitchUrl(`${base}/login?next=${encodeURIComponent(next)}`, locale), choice);
    assert.equal(plan.url.pathname, `${base}/login`);
    assert.equal(plan.url.searchParams.get("next"), next);
    assert.equal(plan.locale, locale);
  }
});

test("OAuth return follows the current login language even if next still has the old prefix", async () => {
  for (const locale of ["ko", "en"] as const) {
    const oldPrefix = locale === "ko" ? "/en" : "";
    const currentPrefix = locale === "en" ? "/en" : "";
    const result = await navigate(languageSwitchUrl(`${oldPrefix}/classroom?session=saved-lecture`, locale), locale === "en" ? "ko" : "en");
    assert.equal(result.url.pathname, `${currentPrefix}/classroom`);
    assert.equal(result.url.searchParams.get("session"), "saved-lecture");
    assert.equal(result.locale, locale);
  }
});

test("viewing public language URLs leaves the stored preference intact; ordinary app routes still use it", async () => {
  const english = await navigate("/en", "ko");
  assert.equal(english.url.pathname, "/en");
  assert.equal(english.locale, "en");
  assert.equal(english.choice, "ko");
  const korean = await navigate("/ko", "en");
  assert.equal(korean.url.pathname, "/ko");
  assert.equal(korean.locale, "ko");
  assert.equal(korean.choice, "en");
  assert.equal((await navigate("/en/classroom", "ko")).url.pathname, "/classroom");
  assert.equal((await navigate("/classroom", "en")).url.pathname, "/en/classroom");
});
