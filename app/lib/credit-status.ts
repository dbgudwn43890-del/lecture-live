import type { SupabaseClient } from "@supabase/supabase-js";

export async function getCreditStatus(supabase: SupabaseClient) {
  const [{ data, error }, { data: grants, error: grantError }] = await Promise.all([
    supabase.rpc("get_credit_status"),
    supabase
      .from("credit_grants")
      .select("plan_code")
      .gt("remaining_credits", 0)
      .lte("starts_at", new Date().toISOString())
      .gt("expires_at", new Date().toISOString())
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (error) return { error: error.code };

  const row = Array.isArray(data) ? data[0] : data;
  return {
    credits: Number(row?.credits ?? 0),
    nextExpiry: row?.next_expiry ?? null,
    latestGrantAt: row?.latest_grant_at ?? null,
    subscriptionStatus: row?.subscription_status ?? null,
    trialUsed: Boolean(row?.trial_used),
    planCode: grantError ? null : grants?.[0]?.plan_code ?? null,
  };
}
