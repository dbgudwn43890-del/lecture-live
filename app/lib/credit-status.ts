import type { SupabaseClient } from "@supabase/supabase-js";

export type CreditStatus = {
  credits: number;
  nextExpiry: string | null;
  latestGrantAt: string | null;
  subscriptionStatus: string | null;
  trialUsed: boolean;
  planCode: string | null;
  nextGrantAt: string | null;
  nextGrantCredits: number;
  scheduledPlanCode: string | null;
  scheduledEndsAt: string | null;
  regularCredits: number;
  regularGrantedCredits: number;
  regularExpiresAt: string | null;
  topupCredits: number;
  topupGrantedCredits: number;
  topupExpiresAt: string | null;
  planEndsAt: string | null;
};

type CreditGrant = {
  plan_code: string;
  granted_credits: number;
  refunded_credits: number;
  remaining_credits: number;
  expires_at: string;
};

const paidPlans = new Set(["monthly", "term", "semester", "halfyear", "annual"]);

function balance(grants: CreditGrant[]) {
  const remainingGrants = grants.filter((grant) => grant.remaining_credits > 0);
  // The next loss of usable credits comes from an unspent grant. Keep the
  // allocation end visible when the entire bucket has already been consumed.
  const expiringGrants = remainingGrants.length ? remainingGrants : grants;
  return {
    remaining: grants.reduce((sum, grant) => sum + grant.remaining_credits, 0),
    // Refunds remove allocation; they are not usage. Exhausted, valid grants
    // remain in the denominator until their period expires.
    granted: grants.reduce((sum, grant) => sum + grant.granted_credits - grant.refunded_credits, 0),
    expiresAt: expiringGrants.reduce<string | null>((earliest, grant) => (
      earliest === null || Date.parse(grant.expires_at) < Date.parse(earliest) ? grant.expires_at : earliest
    ), null),
  };
}

export async function getCreditStatus(
  supabase: SupabaseClient,
  now = new Date(),
): Promise<CreditStatus | { error: string }> {
  const { data, error } = await supabase.rpc("get_credit_status");
  if (error) return { error: error.code || "CREDIT_STATUS_UNAVAILABLE" };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { error: "CREDIT_STATUS_UNAVAILABLE" };
  const timestamp = now.toISOString();
  const grants: CreditGrant[] = [];
  const pageSize = 1000;
  // Keep the authenticated client's owner-only RLS. Future installments do
  // not count as today's allocation; an expired trial still names the free plan.
  for (let offset = 0; ; offset += pageSize) {
    const { data: page, error: grantError } = await supabase
      .from("credit_grants")
      .select("plan_code,granted_credits,refunded_credits,remaining_credits,expires_at")
      .lte("starts_at", timestamp)
      .or(`expires_at.gt.${timestamp},plan_code.eq.trial`)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (grantError || !page) return { error: grantError?.code || "CREDIT_GRANTS_UNAVAILABLE" };
    grants.push(...page);
    if (page.length < pageSize) break;
  }
  const available = grants.filter((grant) => grant.granted_credits > grant.refunded_credits);
  const active = available.filter((grant) => Date.parse(grant.expires_at) > now.getTime());
  const regularGrants = active.filter((grant) => grant.plan_code !== "topup");
  const topupGrants = active.filter((grant) => grant.plan_code === "topup");
  const regular = balance(regularGrants);
  const topup = balance(topupGrants);
  // A top-up must not replace a paid plan or the free plan in the profile.
  const regularPlan = regularGrants.find((grant) => paidPlans.has(grant.plan_code))
    ?? available.find((grant) => grant.plan_code === "trial")
    ?? regularGrants[0];
  return {
    credits: Number(row?.credits ?? 0),
    nextExpiry: row?.next_expiry ?? null,
    latestGrantAt: row?.latest_grant_at ?? null,
    subscriptionStatus: row?.subscription_status ?? null,
    trialUsed: Boolean(row?.trial_used),
    planCode: row?.scheduled_plan_code ?? regularPlan?.plan_code ?? topupGrants[0]?.plan_code ?? null,
    nextGrantAt: row?.next_grant_at ?? null,
    nextGrantCredits: Number(row?.next_grant_credits ?? 0),
    scheduledPlanCode: row?.scheduled_plan_code ?? null,
    scheduledEndsAt: row?.scheduled_ends_at ?? null,
    regularCredits: regular.remaining,
    regularGrantedCredits: regular.granted,
    regularExpiresAt: regular.expiresAt,
    topupCredits: topup.remaining,
    topupGrantedCredits: topup.granted,
    topupExpiresAt: topup.expiresAt,
    planEndsAt: row?.scheduled_ends_at ?? regularPlan?.expires_at ?? null,
  };
}
