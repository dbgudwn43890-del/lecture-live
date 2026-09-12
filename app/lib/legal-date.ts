// The operator confirmed the effective date on 2026-09-11.
// These are document dates, independent of deployment and consent-gate versions.
export const PRIVACY_POLICY_DATES = {
  effective: "2026-08-31",
  dateClarified: "2026-09-11",
} as const;

export function formatLegalDate(date: string, locale: "ko" | "en") {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}
