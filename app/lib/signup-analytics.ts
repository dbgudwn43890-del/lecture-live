// Server-only orchestration; deliberately independent of browser timestamp
// heuristics and independent of any user ID supplied in a request body.
export const SIGNUP_ANALYTICS_CONSENT_COOKIE = "lecue-analytics-consent";

export function isSignupAnalyticsEnabled(measurementId: string | undefined) {
  return /^G-[A-Z0-9]{6,20}$/.test(measurementId ?? "");
}

export function allowsSignupAnalytics(consent: string | undefined) {
  return consent === "granted";
}

export function isSameOriginAnalyticsRequest(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return origin === new URL(request.url).origin && (!fetchSite || fetchSite === "same-origin");
}

type RpcClient = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string } | null;
  }>;
};

export async function finalizeSignupAnalytics(
  supabase: RpcClient,
  consent: string | undefined,
  measurementId: string | undefined,
) {
  try {
    // Even when the feature is disabled, consume pending eligibility as denied.
    // A later sign-in after analytics rollout is not a new account conversion.
    const result = await supabase.rpc("finalize_signup_analytics", {
      p_allowed: isSignupAnalyticsEnabled(measurementId) && allowsSignupAnalytics(consent),
    });
    return !result.error;
  } catch {
    // Authentication must stay functional if the optional migration is absent.
    return false;
  }
}

export async function claimSignupAnalytics(supabase: RpcClient): Promise<{
  eligible: boolean;
  method?: "google" | "email" | "other";
}> {
  const { data, error } = await supabase.rpc("claim_signup_analytics");
  if (error) throw new Error("Signup analytics claim unavailable");
  if (!Array.isArray(data) || data.length !== 1) return { eligible: false };
  const method: unknown = data[0]?.method;
  if (method !== "google" && method !== "email" && method !== "other") return { eligible: false };
  return { eligible: true, method };
}
