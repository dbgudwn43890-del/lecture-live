"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  analyticsConsentCookie,
  buildSanitizedPageView,
  buildAnalyticsConsent,
  isValidGa4MeasurementId,
  parseAnalyticsConsent,
  sanitizeSignupMethod,
  setAnalyticsTransport,
  trackAnalyticsEvent,
  trackSanitizedPageView,
  type AnalyticsConsent,
} from "../lib/analytics";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const measurementId = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;

const panelStyle: CSSProperties = {
  position: "fixed",
  zIndex: 10000,
  right: "1rem",
  bottom: "1rem",
  width: "min(32rem, calc(100vw - 2rem))",
  padding: "1rem",
  border: "1px solid #777",
  borderRadius: ".75rem",
  background: "Canvas",
  color: "CanvasText",
  boxShadow: "0 8px 30px rgba(0,0,0,.2)",
  font: "inherit",
};

const choiceStyle: CSSProperties = {
  flex: 1,
  minHeight: "2.75rem",
  padding: ".6rem .9rem",
  border: "1px solid currentColor",
  borderRadius: ".45rem",
  background: "Canvas",
  color: "CanvasText",
  font: "inherit",
  fontWeight: 700,
  cursor: "pointer",
};

function installGtagQueue() {
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = window.gtag ?? function gtag(...args: unknown[]) {
    void args;
    window.dataLayer!.push(arguments);
  };
  return window.gtag;
}

function disableGoogleAnalytics(measurementId: string) {
  (window as unknown as Record<string, unknown>)[`ga-disable-${measurementId}`] = true;
  setAnalyticsTransport(null);
}

function broadcastConsent(value: "granted" | "denied") {
  try { localStorage.setItem("lecue-analytics-consent-sync", value); } catch { /* Focus and send-time checks remain active. */ }
}

function clearGoogleAnalyticsCookies() {
  const names = document.cookie.split(";")
    .map((part) => part.slice(0, part.indexOf("=")).trim())
    .filter((name) => name === "_gid" || name.startsWith("_ga") || name.startsWith("_gat")
      || name.startsWith("_gac_") || name.startsWith("_gcl_"));
  const host = window.location.hostname;
  const rootDomain = host.split(".").slice(-2).join(".");
  for (const name of names) {
    for (const domain of ["", host, `.${host}`, rootDomain, `.${rootDomain}`]) {
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${domain ? `; Domain=${domain}` : ""}`;
    }
  }
}

export default function AnalyticsProvider({ locale, children }: { locale: "ko" | "en"; children: ReactNode }) {
  // Keep the entire client analytics runtime inert when no valid public ID was
  // provided. In particular, do not mount effects, listeners, or consent UI.
  if (!isValidGa4MeasurementId(measurementId)) return <>{children}</>;
  return <ConfiguredAnalyticsProvider locale={locale} measurementId={measurementId}>{children}</ConfiguredAnalyticsProvider>;
}

function ConfiguredAnalyticsProvider({ locale, measurementId, children }: {
  locale: "ko" | "en";
  measurementId: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [consent, setConsent] = useState<AnalyticsConsent | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tagReady, setTagReady] = useState(false);
  const consentGrantedRef = useRef(false);
  const viewedPathRef = useRef("");
  const initialReferrerRef = useRef("");
  const signupCheckedRef = useRef(false);
  const signupSentRef = useRef(false);

  useEffect(() => {
    setConsent(parseAnalyticsConsent(document.cookie));
    initialReferrerRef.current = document.referrer;
  }, []);

  useEffect(() => {
    if (consent !== "granted" || parseAnalyticsConsent(document.cookie) !== "granted") {
      consentGrantedRef.current = false;
      setAnalyticsTransport(null);
      setTagReady(false);
      return;
    }

    consentGrantedRef.current = true;
    const gtag = installGtagQueue();
    gtag("consent", "default", {
      ...buildAnalyticsConsent(false),
      wait_for_update: 500,
    });

    let active = true;
    const initialize = () => {
      if (!active || !consentGrantedRef.current || !window.gtag || parseAnalyticsConsent(document.cookie) !== "granted") return;
      (window as unknown as Record<string, unknown>)[`ga-disable-${measurementId}`] = false;
      const currentGtag = window.gtag;
      currentGtag("js", new Date());
      currentGtag("consent", "update", buildAnalyticsConsent(true));
      currentGtag("config", measurementId, {
        ...buildSanitizedPageView(window.location.href, document.referrer),
        send_page_view: false,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        anonymize_ip: true,
        cookie_flags: "SameSite=Lax;Secure",
      });
      setAnalyticsTransport((command, name, params) => {
        if (!consentGrantedRef.current || parseAnalyticsConsent(document.cookie) !== "granted") {
          disableGoogleAnalytics(measurementId);
          return;
        }
        currentGtag(command, name, params);
      });
      setTagReady(true);
    };

    const existing = document.querySelector<HTMLScriptElement>("script[data-lecue-ga4]");
    if (existing?.dataset.ready === "true") {
      initialize();
      return () => { active = false; };
    }

    const script = existing ?? document.createElement("script");
    const onLoad = () => {
      script.dataset.ready = "true";
      initialize();
    };
    script.addEventListener("load", onLoad, { once: true });
    if (!existing) {
      script.async = true;
      script.referrerPolicy = "no-referrer";
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
      script.dataset.lecueGa4 = "true";
      document.head.appendChild(script);
    }
    return () => {
      active = false;
      script.removeEventListener("load", onLoad);
    };
  }, [consent, measurementId]);

  useEffect(() => {
    if (!tagReady || consent !== "granted") return;
    if (viewedPathRef.current === pathname) return;
    viewedPathRef.current = pathname;
    trackSanitizedPageView(window.location.href, initialReferrerRef.current);
    initialReferrerRef.current = "";
  }, [consent, pathname, tagReady]);

  useEffect(() => {
    if (!tagReady || consent !== "granted") return;
    if (!["/classroom", "/en/classroom", "/billing", "/en/billing"].includes(pathname)) return;
    if (signupCheckedRef.current) return;
    signupCheckedRef.current = true;

    // The same-origin endpoint owns the atomic eligibility marker. The request
    // body carries no identifier; its auth cookie is never forwarded to Google,
    // and the browser never infers sign-up from client-side timestamps.
    void fetch("/api/analytics/signup", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { eligible?: unknown; method?: unknown };
      const method = sanitizeSignupMethod(data.method);
      if (data.eligible !== true || !method || signupSentRef.current) return;
      signupSentRef.current = trackAnalyticsEvent("sign_up", { method });
    }).catch(() => {
      // Intentionally no automatic retry: the endpoint is authoritative and
      // GA delivery may be blocked independently of server-side eligibility.
    });
  }, [consent, pathname, tagReady]);

  useEffect(() => {
    function handleAnalyticsClick(event: MouseEvent) {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-analytics-event]")
        : null;
      if (target?.dataset.analyticsEvent === "landing_cta_click") {
        const placement = target.dataset.analyticsPlacement;
        if (placement === "header" || placement === "hero" || placement === "demo" || placement === "closing") {
          trackAnalyticsEvent("landing_cta_click", { locale, placement });
        }
        return;
      }
      // Updated main keeps auth behavior in login-client. Delegation preserves
      // that component while still recording the explicit Google start action.
      const googleButton = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".google-auth-button")
        : null;
      if (googleButton && (pathname === "/login" || pathname === "/en/login")) {
        trackAnalyticsEvent("auth_started", { locale, placement: "login" });
      }
    }
    document.addEventListener("click", handleAnalyticsClick);
    return () => document.removeEventListener("click", handleAnalyticsClick);
  }, [locale, pathname]);

  useEffect(() => {
    function syncConsent() {
      const current = parseAnalyticsConsent(document.cookie);
      if (consentGrantedRef.current && current !== "granted") {
        consentGrantedRef.current = false;
        disableGoogleAnalytics(measurementId);
        clearGoogleAnalyticsCookies();
        window.location.reload();
        return;
      }
      setConsent(current);
    }
    window.addEventListener("storage", syncConsent);
    window.addEventListener("focus", syncConsent);
    return () => {
      window.removeEventListener("storage", syncConsent);
      window.removeEventListener("focus", syncConsent);
    };
  }, [measurementId]);

  function saveConsent(next: "granted" | "denied") {
    document.cookie = analyticsConsentCookie(next, window.location.protocol === "https:");
    broadcastConsent(next);
    setConsent(next);
    setSettingsOpen(false);
  }

  function withdrawConsent() {
    // Disable every app-owned send path before changing persisted state. Do not
    // call gtag for the withdrawal itself, since that would be another Google send.
    consentGrantedRef.current = false;
    disableGoogleAnalytics(measurementId);
    setTagReady(false);
    setConsent("denied");
    document.cookie = analyticsConsentCookie("denied", window.location.protocol === "https:");
    broadcastConsent("denied");
    clearGoogleAnalyticsCookies();
    document.querySelector<HTMLScriptElement>("script[data-lecue-ga4]")?.remove();
    window.gtag = undefined;
    window.dataLayer = undefined;
    // Reload immediately so no already executing tag remains in this document.
    window.location.reload();
  }

  const showPanel = consent === "unknown" || settingsOpen;
  const isEnglish = locale === "en";
  const privacyPath = isEnglish ? "/en/privacy" : "/privacy";

  return (
    <>
      {children}
      <button
        type="button"
        onClick={() => setSettingsOpen((open) => !open)}
        aria-expanded={showPanel}
        aria-controls="analytics-consent-panel"
        style={{
          // Keep the header's language/account controls and bottom composer clear.
          position: "fixed", zIndex: 10001, right: 0, top: "50%", transform: "translateY(-50%)",
          writingMode: "vertical-rl", padding: ".65rem .4rem",
          border: "1px solid #777", borderRadius: ".5rem 0 0 .5rem", background: "Canvas", color: "CanvasText",
          font: "inherit", fontSize: ".75rem", cursor: "pointer",
        }}
      >
        {isEnglish ? "Analytics settings" : "분석 설정"}
      </button>
      {showPanel && (
        <section id="analytics-consent-panel" role="dialog" aria-modal="false" aria-labelledby="analytics-consent-title" style={panelStyle}>
          <strong id="analytics-consent-title" style={{ display: "block", marginBottom: ".45rem" }}>
            {isEnglish ? "Optional analytics" : "선택 분석 설정"}
          </strong>
          <p style={{ margin: "0 0 .8rem", lineHeight: 1.5 }}>
            {isEnglish
              ? "With your permission, Lecue uses Google Analytics and shares conversion data with Google Ads to measure product use and ad results, not to personalize ads. Rejecting does not affect core features."
              : "동의하면 Lecue가 Google Analytics를 사용하고 Google Ads와 전환 데이터를 공유해 제품 이용과 광고 성과를 측정합니다. 맞춤 광고에는 사용하지 않으며, 거부해도 핵심 기능은 그대로 이용할 수 있습니다."}
            {" "}<Link href={privacyPath}>{isEnglish ? "Details" : "자세히 보기"}</Link>
          </p>
          <div style={{ display: "flex", gap: ".65rem" }}>
            <button type="button" style={choiceStyle} onClick={() => saveConsent("granted")}>
              {isEnglish ? "Accept" : "동의"}
            </button>
            <button type="button" style={choiceStyle} onClick={() => consent === "granted" ? withdrawConsent() : saveConsent("denied")}>
              {consent === "granted"
                ? isEnglish ? "Withdraw" : "동의 철회"
                : isEnglish ? "Reject" : "거부"}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
