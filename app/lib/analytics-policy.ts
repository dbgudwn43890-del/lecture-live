// Only these fields may cross the Google boundary. Never accept arbitrary event params.
export const ANALYTICS_CONSENT = "lecue-analytics-v1";
export const ANALYTICS_EVENTS = ["page_view", "landing_view", "signup_click", "sign_up", "recording_start", "answer_complete", "review_note_complete"] as const;
export type AnalyticsEvent = typeof ANALYTICS_EVENTS[number];
export const CAMPAIGN = { utm_source: "youtube", utm_medium: "paid_video", utm_campaign: "us_youtube_launch" } as const;

export function safeAnalyticsLocation(raw: string): string {
  const url = new URL(raw, "https://www.lecue.app");
  const path = /^\/(?:en\/)?(?:login|classroom|billing|privacy|terms)$/.test(url.pathname)
    || ["/", "/en", "/ko"].includes(url.pathname) ? url.pathname : "/other";
  const safe = new URL(path, "https://www.lecue.app");
  for (const [key, value] of Object.entries(CAMPAIGN)) {
    if (url.searchParams.get(key) === value) safe.searchParams.set(key, value);
  }
  for (const key of ["gclid", "gbraid", "wbraid"]) {
    const value = url.searchParams.get(key);
    if (value && /^[A-Za-z0-9_-]{10,256}$/.test(value)) safe.searchParams.set(key, value);
  }
  return safe.href;
}

export function analyticsEnabled(id: string | undefined): id is string {
  return Boolean(id && /^G-[A-Z0-9]{6,20}$/.test(id));
}
