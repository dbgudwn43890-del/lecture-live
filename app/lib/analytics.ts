export const ANALYTICS_CONSENT_COOKIE = "lecue-analytics-consent";

export type AnalyticsConsent = "granted" | "denied" | "unknown";
export type AnalyticsLocale = "ko" | "en";
export type AnalyticsPlacement = "header" | "hero" | "demo" | "closing" | "login" | "create" | "regenerate";
export type AnalyticsInputSource = "microphone" | "browser_tab" | "composer" | "catchup" | "example" | "transcript";
export type AnalyticsSignupMethod = "google" | "email" | "other";

export type AnalyticsEventMap = {
  landing_cta_click: { locale: AnalyticsLocale; placement: "header" | "hero" | "demo" | "closing" };
  auth_started: { locale: AnalyticsLocale; placement: "login" };
  recording_started: { locale: AnalyticsLocale; input_source: "microphone" | "browser_tab" };
  question_answered: { locale: AnalyticsLocale; input_source: "composer" | "catchup" | "example" | "transcript" };
  review_note_ready: { locale: AnalyticsLocale; placement: "create" | "regenerate" };
  sign_up: { method: AnalyticsSignupMethod };
};

export type AnalyticsEventName = keyof AnalyticsEventMap;
export type AnalyticsEvent = {
  [Name in AnalyticsEventName]: { name: Name; params: AnalyticsEventMap[Name] }
}[AnalyticsEventName];

export type Gtag = (command: "event", name: string, params?: Record<string, unknown>) => void;

let analyticsTransport: Gtag | null = null;

const STATIC_PATHS = new Map<string, { path: string; title: string }>([
  ["/", { path: "/", title: "Lecue | Home" }],
  ["/en", { path: "/en", title: "Lecue | Home" }],
  ["/login", { path: "/login", title: "Lecue | Login" }],
  ["/en/login", { path: "/en/login", title: "Lecue | Login" }],
  ["/classroom", { path: "/classroom", title: "Lecue | Classroom" }],
  ["/en/classroom", { path: "/en/classroom", title: "Lecue | Classroom" }],
  ["/billing", { path: "/billing", title: "Lecue | Plans" }],
  ["/en/billing", { path: "/en/billing", title: "Lecue | Plans" }],
  ["/privacy", { path: "/privacy", title: "Lecue | Privacy" }],
  ["/en/privacy", { path: "/en/privacy", title: "Lecue | Privacy" }],
  ["/terms", { path: "/terms", title: "Lecue | Terms" }],
  ["/en/terms", { path: "/en/terms", title: "Lecue | Terms" }],
  ["/policy", { path: "/policy", title: "Lecue | Policy" }],
  ["/en/policy", { path: "/en/policy", title: "Lecue | Policy" }],
  ["/refund-policy", { path: "/refund-policy", title: "Lecue | Refund policy" }],
  ["/en/refund-policy", { path: "/en/refund-policy", title: "Lecue | Refund policy" }],
  ["/auth/callback", { path: "/auth", title: "Lecue | Authentication" }],
]);

const GOOGLE_CLICK_IDS = new Set(["gclid", "dclid", "gbraid", "wbraid"]);
const UTM_VALUES: Record<string, ReadonlySet<string>> = {
  utm_source: new Set(["google", "youtube", "naver", "newsletter", "producthunt"]),
  utm_medium: new Set(["cpc", "paid_video", "email", "social", "referral"]),
  utm_campaign: new Set(["launch", "early_access", "beta", "brand", "lecue_us_college_7d"]),
  utm_content: new Set(["listens_with_you_v2"]),
};

const LOCALES = new Set<AnalyticsLocale>(["ko", "en"]);
const LANDING_PLACEMENTS = new Set(["header", "hero", "demo", "closing"] as const);
const RECORDING_INPUTS = new Set(["microphone", "browser_tab"] as const);
const QUESTION_INPUTS = new Set(["composer", "catchup", "example", "transcript"] as const);
const NOTE_PLACEMENTS = new Set(["create", "regenerate"] as const);
const SIGNUP_METHODS = new Set<AnalyticsSignupMethod>(["google", "email", "other"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePathname(pathname: string) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "") || "/";
}

function pageDefinition(pathname: string) {
  const normalized = normalizePathname(pathname);
  const known = STATIC_PATHS.get(normalized);
  if (known) return known;
  // A future detail route must never expose its arbitrary identifier to Google.
  if (normalized.startsWith("/en/classroom/")) return STATIC_PATHS.get("/en/classroom")!;
  if (normalized.startsWith("/classroom/")) return STATIC_PATHS.get("/classroom")!;
  return normalized === "/en" || normalized.startsWith("/en/")
    ? { path: "/en/other", title: "Lecue | Other" }
    : { path: "/other", title: "Lecue | Other" };
}

/** Only fixed route categories and tightly validated attribution values survive. */
export function sanitizePageLocation(rawUrl: string): { page_location: string; page_title: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, "https://www.lecue.app");
  } catch {
    parsed = new URL("https://www.lecue.app/other");
  }
  const definition = pageDefinition(parsed.pathname);
  const safe = new URL(definition.path, "https://www.lecue.app");
  for (const [rawKey, rawValue] of parsed.searchParams) {
    const key = rawKey.toLowerCase();
    if (GOOGLE_CLICK_IDS.has(key) && /^[A-Za-z0-9_-]{8,200}$/.test(rawValue)) {
      safe.searchParams.set(key, rawValue);
      continue;
    }
    const value = rawValue.toLowerCase();
    if (UTM_VALUES[key]?.has(value)) safe.searchParams.set(key, value);
  }
  return { page_location: safe.toString(), page_title: definition.title };
}

/** Preserve real known source origins, never private paths or invented referrals. */
export function sanitizePageReferrer(rawReferrer: string, currentUrl: string): string {
  if (!rawReferrer) return "";
  try {
    const referrer = new URL(rawReferrer);
    const current = new URL(currentUrl, "https://www.lecue.app");
    if (referrer.origin === current.origin) {
      const definition = pageDefinition(referrer.pathname);
      return new URL(definition.path, "https://www.lecue.app").toString();
    }
    const host = referrer.hostname.toLowerCase();
    const publicHosts = new Set([
      "google.com", "www.google.com", "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
      "naver.com", "www.naver.com", "search.naver.com", "bing.com", "www.bing.com",
      "duckduckgo.com", "www.duckduckgo.com", "producthunt.com", "www.producthunt.com",
    ]);
    return publicHosts.has(host) && referrer.protocol === "https:" ? `https://${host}/` : "";
  } catch {
    return "";
  }
}

export function buildSanitizedPageView(rawUrl: string, rawReferrer = "") {
  const page = sanitizePageLocation(rawUrl);
  const pageReferrer = sanitizePageReferrer(rawReferrer, rawUrl);
  return { ...page, page_referrer: pageReferrer }; // Empty explicitly suppresses GA's raw default.
}

export function parseAnalyticsConsent(cookieHeader: string): AnalyticsConsent {
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== ANALYTICS_CONSENT_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value === "granted" || value === "denied" ? value : "unknown";
  }
  return "unknown";
}

export function analyticsConsentCookie(value: Exclude<AnalyticsConsent, "unknown">, secure = true) {
  return `${ANALYTICS_CONSENT_COOKIE}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function buildAnalyticsConsent(allowed: boolean) {
  const state = allowed ? "granted" : "denied";
  return {
    analytics_storage: state,
    ad_storage: state,
    ad_user_data: state,
    ad_personalization: "denied" as const,
  };
}

export function isValidGa4MeasurementId(value: string | undefined): value is string {
  return typeof value === "string" && /^G-[A-Z0-9]{6,20}$/.test(value);
}

export function sanitizeSignupMethod(value: unknown): AnalyticsSignupMethod | null {
  return typeof value === "string" && SIGNUP_METHODS.has(value as AnalyticsSignupMethod)
    ? value as AnalyticsSignupMethod
    : null;
}

export function sanitizeAnalyticsEvent(name: unknown, params: unknown): AnalyticsEvent | null {
  if (!isRecord(params) || typeof name !== "string") return null;
  const locale = params.locale;
  switch (name) {
    case "landing_cta_click":
      return LOCALES.has(locale as AnalyticsLocale) && LANDING_PLACEMENTS.has(params.placement as never)
        ? { name, params: { locale: locale as AnalyticsLocale, placement: params.placement as AnalyticsEventMap["landing_cta_click"]["placement"] } }
        : null;
    case "auth_started":
      return LOCALES.has(locale as AnalyticsLocale) && params.placement === "login"
        ? { name, params: { locale: locale as AnalyticsLocale, placement: "login" } }
        : null;
    case "recording_started":
      return LOCALES.has(locale as AnalyticsLocale) && RECORDING_INPUTS.has(params.input_source as never)
        ? { name, params: { locale: locale as AnalyticsLocale, input_source: params.input_source as AnalyticsEventMap["recording_started"]["input_source"] } }
        : null;
    case "question_answered":
      return LOCALES.has(locale as AnalyticsLocale) && QUESTION_INPUTS.has(params.input_source as never)
        ? { name, params: { locale: locale as AnalyticsLocale, input_source: params.input_source as AnalyticsEventMap["question_answered"]["input_source"] } }
        : null;
    case "review_note_ready":
      return LOCALES.has(locale as AnalyticsLocale) && NOTE_PLACEMENTS.has(params.placement as never)
        ? { name, params: { locale: locale as AnalyticsLocale, placement: params.placement as AnalyticsEventMap["review_note_ready"]["placement"] } }
        : null;
    case "sign_up": {
      const method = sanitizeSignupMethod(params.method);
      return method ? { name, params: { method } } : null;
    }
    default:
      return null;
  }
}

/** Enabled only by the consent provider after the Google tag has loaded and been configured. */
export function setAnalyticsTransport(transport: Gtag | null) {
  analyticsTransport = transport;
}

export function trackAnalyticsEvent<Name extends AnalyticsEventName>(name: Name, params: AnalyticsEventMap[Name]): boolean {
  const event = sanitizeAnalyticsEvent(name, params);
  if (!analyticsTransport || !event) return false;
  const context = buildSanitizedPageView(
    typeof window === "undefined" ? "https://www.lecue.app/other" : window.location.href,
    typeof document === "undefined" ? "" : document.referrer,
  );
  analyticsTransport("event", event.name, { ...event.params, ...context });
  return true;
}

export function trackSanitizedPageView(rawUrl: string, rawReferrer = ""): boolean {
  if (!analyticsTransport) return false;
  analyticsTransport("event", "page_view", buildSanitizedPageView(rawUrl, rawReferrer));
  return true;
}
