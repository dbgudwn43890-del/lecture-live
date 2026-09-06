import { headers } from "next/headers";
import { createClient } from "../lib/supabase/server";
import { billingMode } from "../lib/billing-config";
import BillingClient from "./billing-client";

export default async function BillingPage({ locale: specified }: { locale?: "ko" | "en" }) {
  const locale = specified ?? ((await headers()).get("x-site-locale") === "en" ? "en" : "ko");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: account } = user ? await supabase.from("billing_accounts").select("paddle_customer_id,subscription_status,next_billed_at,scheduled_cancel_at").eq("user_id", user.id).maybeSingle() : { data: null };
  return <BillingClient locale={locale} signedIn={Boolean(user)} mode={billingMode()} account={account} />;
}
