import { headers } from "next/headers";
import { createClient } from "../lib/supabase/server";
import { availablePlans, billingMode, purchasePriceId } from "../lib/billing-config";
import { hasVerifiedEmail } from "../lib/verified-email";
import { getSiteRegion } from "../lib/site-region";
import BillingClient from "./billing-client";

export default async function BillingContent({ locale: specified }: { locale?: "ko" | "en" }) {
  const locale = specified ?? ((await headers()).get("x-site-locale") === "en" ? "en" : "ko");
  const region = await getSiteRegion();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const signedIn = hasVerifiedEmail(user);
  const { data: account } = signedIn && user ? await supabase.from("billing_accounts").select("paddle_customer_id,subscription_status,next_billed_at,scheduled_cancel_at").eq("user_id", user.id).maybeSingle() : { data: null };
  const available = availablePlans();
  const prices = Object.fromEntries(available.map(plan => [plan, purchasePriceId(plan)]));
  return <BillingClient locale={locale} region={region} signedIn={signedIn} email={signedIn ? user?.email : undefined} mode={billingMode()} available={available} priceIds={prices} account={account} />;
}
