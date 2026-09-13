import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYTICS_CONSENT_COOKIE,
  analyticsConsentCookie,
  buildSanitizedPageView,
  buildAnalyticsConsent,
  isValidGa4MeasurementId,
  parseAnalyticsConsent,
  sanitizeAnalyticsEvent,
  sanitizePageLocation,
  sanitizePageReferrer,
  sanitizeSignupMethod,
  setAnalyticsTransport,
  trackAnalyticsEvent,
  trackSanitizedPageView,
} from "./analytics.ts";

test("consent helpers default to denied behavior for missing or malformed values", () => {
  assert.equal(parseAnalyticsConsent("theme=dark"), "unknown");
  assert.equal(parseAnalyticsConsent(`${ANALYTICS_CONSENT_COOKIE}=maybe`), "unknown");
  assert.equal(parseAnalyticsConsent(`a=1; ${ANALYTICS_CONSENT_COOKIE}=granted; b=2`), "granted");
  assert.equal(parseAnalyticsConsent(`${ANALYTICS_CONSENT_COOKIE}=denied`), "denied");
  assert.equal(analyticsConsentCookie("denied", false), `${ANALYTICS_CONSENT_COOKIE}=denied; Path=/; Max-Age=31536000; SameSite=Lax`);
});

test("only opt-in enables conversion measurement; personalization is always denied", () => {
  assert.deepEqual(buildAnalyticsConsent(false), { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  assert.deepEqual(buildAnalyticsConsent(true), { analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted", ad_personalization: "denied" });
});

test("GA4 measurement IDs are validated before analytics can load", () => {
  assert.equal(isValidGa4MeasurementId("G-ABC12345"), true);
  assert.equal(isValidGa4MeasurementId("UA-123-4"), false);
  assert.equal(isValidGa4MeasurementId("G-short"), false);
  assert.equal(isValidGa4MeasurementId(undefined), false);
});

test("page views collapse arbitrary routes and discard unsafe query data", () => {
  assert.deepEqual(
    sanitizePageLocation("https://lecue.app/classroom/private-session?session=secret&email=a%40b.com"),
    { page_location: "https://www.lecue.app/classroom", page_title: "Lecue | Classroom" },
  );
  assert.deepEqual(
    sanitizePageLocation("https://lecue.app/en/classroom/private/session?transcript=secret"),
    { page_location: "https://www.lecue.app/en/classroom", page_title: "Lecue | Classroom" },
  );
  assert.deepEqual(
    sanitizePageLocation("https://lecue.app/auth/callback?code=oauth-secret&session_id=session-secret&next=/classroom/private"),
    { page_location: "https://www.lecue.app/auth", page_title: "Lecue | Authentication" },
  );
  assert.deepEqual(
    sanitizePageLocation("https://lecue.app/users/private-session?code=secret"),
    { page_location: "https://www.lecue.app/other", page_title: "Lecue | Other" },
  );
});

test("only validated Google click IDs and known UTM values remain", () => {
  const safe = sanitizePageLocation("https://lecue.app/?gclid=AbCd_123456&utm_source=GOOGLE&utm_medium=cpc&utm_campaign=launch&utm_content=private&gbraid=bad!");
  assert.equal(safe.page_location, "https://www.lecue.app/?gclid=AbCd_123456&utm_source=google&utm_medium=cpc&utm_campaign=launch");
  assert.equal(sanitizePageLocation("https://lecue.app/?utm_campaign=customer-name&utm_source=unknown").page_location, "https://www.lecue.app/");
});

test("referrers retain real safe origins and never fall back to raw URLs", () => {
  assert.equal(sanitizePageReferrer("https://www.google.com/search?q=private", "https://lecue.app/"), "https://www.google.com/");
  assert.equal(sanitizePageReferrer("https://unexpected.example/users/alice", "https://lecue.app/"), "");
  assert.equal(sanitizePageReferrer("https://lecue.app/classroom/secret?id=1", "https://lecue.app/classroom"), "https://www.lecue.app/classroom");
  assert.deepEqual(buildSanitizedPageView("https://lecue.app/login?next=/private", ""), {
    page_location: "https://www.lecue.app/login",
    page_title: "Lecue | Login",
    page_referrer: "",
  });
  assert.equal(sanitizePageReferrer("https://accounts.google.com/signin?code=private", "https://lecue.app/"), "");
});

test("event sanitization allows only named enums and drops all supplied content", () => {
  assert.deepEqual(sanitizeAnalyticsEvent("question_answered", {
    locale: "ko",
    input_source: "composer",
    question: "private question",
    session_id: "secret",
  }), { name: "question_answered", params: { locale: "ko", input_source: "composer" } });
  assert.equal(sanitizeAnalyticsEvent("question_answered", { locale: "ko", input_source: "other" }), null);
  assert.equal(sanitizeAnalyticsEvent("arbitrary_event", { locale: "ko" }), null);
  assert.equal(sanitizeSignupMethod("google"), "google");
  assert.equal(sanitizeSignupMethod("other"), "other");
  assert.equal(sanitizeSignupMethod("custom-provider"), null);
  assert.deepEqual(sanitizeAnalyticsEvent("sign_up", { method: "email", email: "private@example.com", user_id: "secret" }), {
    name: "sign_up", params: { method: "email" },
  });
});

test("tracking is inert until a consent-ready transport exists", () => {
  const calls: unknown[][] = [];
  setAnalyticsTransport(null);
  assert.equal(trackAnalyticsEvent("auth_started", { locale: "en", placement: "login" }), false);
  assert.equal(trackSanitizedPageView("https://lecue.app/login?code=secret"), false);
  setAnalyticsTransport((...args) => calls.push(args));
  assert.equal(trackAnalyticsEvent("auth_started", { locale: "en", placement: "login" }), true);
  assert.equal(trackSanitizedPageView("https://lecue.app/login?code=secret"), true);
  assert.deepEqual(calls, [
    ["event", "auth_started", { locale: "en", placement: "login", page_location: "https://www.lecue.app/other", page_title: "Lecue | Other", page_referrer: "" }],
    ["event", "page_view", { page_location: "https://www.lecue.app/login", page_title: "Lecue | Login", page_referrer: "" }],
  ]);
  setAnalyticsTransport(null);
});

test("approved ad attribution survives without private query parameters", () => {
  const url = "https://www.lecue.app/en?utm_source=youtube&utm_medium=paid_video&utm_campaign=lecue_us_college_7d&utm_content=listens_with_you_v2";
  assert.equal(sanitizePageLocation(`${url}&email=private&session=secret#transcript`).page_location, url);
});

test("every product event overrides private browser context", () => {
  const calls: unknown[][] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://lecue.app/classroom/private?session=secret&code=oauth" } } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { referrer: "https://unknown.example/private?email=secret" } });
  try {
    setAnalyticsTransport((...args) => calls.push(args));
    trackAnalyticsEvent("question_answered", { locale: "en", input_source: "composer" });
    assert.deepEqual(calls, [["event", "question_answered", {
      locale: "en", input_source: "composer", page_location: "https://www.lecue.app/classroom",
      page_title: "Lecue | Classroom", page_referrer: "",
    }]]);
  } finally {
    setAnalyticsTransport(null);
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});
