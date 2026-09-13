"use client";

import { ANALYTICS_CONSENT, type AnalyticsEvent } from "./analytics-policy";

export function hasAnalyticsConsent() {
  try {
    return document.cookie.split("; ").includes(`${ANALYTICS_CONSENT}=granted`)
      && localStorage.getItem(ANALYTICS_CONSENT) === "granted";
  } catch { return false; }
}

// Deliberately synchronous and non-throwing: recording/auth never await analytics.
export function trackAnalytics(event: Exclude<AnalyticsEvent, "sign_up">) {
  try {
    if (hasAnalyticsConsent()) window.dispatchEvent(new CustomEvent("lecue:analytics", { detail: event }));
  } catch { /* Optional analytics must never affect a product action. */ }
}
