import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../../lib/auth";
import { isBillingPlan, paddlePriceId, paddleRequest } from "../../../lib/billing";
import { checkSharedRateLimit } from "../../../lib/rate-limit";
import { createAdminClient } from "../../../lib/supabase/admin";

export const runtime = "nodejs";

type Transaction = { id: string };

export async function POST(request: Request) {
  const isEnglish = request.headers.get("x-site-locale") === "en";
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });
  const rateLimit = await checkSharedRateLimit(`billing-checkout:${userId}`, 6, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: isEnglish ? "Too many checkout requests. Try again shortly." : "결제 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." }, { status: 429 });
  }

  let body: { plan?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid checkout request." : "결제 요청을 확인해 주세요." }, { status: 400 });
  }
  if (!isBillingPlan(body.plan)) return NextResponse.json({ error: isEnglish ? "Choose a valid plan." : "요금제를 확인해 주세요." }, { status: 400 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: isEnglish ? "Billing storage is not configured." : "결제 저장 기능이 설정되지 않았습니다." }, { status: 503 });
  const { data: account, error: accountError } = await admin
    .from("billing_accounts")
    .select("paddle_customer_id,subscription_status,trial_used_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (accountError) {
    console.error("Billing account read failed", accountError.code);
    return NextResponse.json({ error: isEnglish ? "Billing is not ready yet." : "결제 기능이 아직 준비되지 않았습니다." }, { status: 503 });
  }
  if (body.plan === "monthly" && account && ["trialing", "active", "past_due", "paused"].includes(account.subscription_status ?? "")) {
    return NextResponse.json({
      code: "ACTIVE_SUBSCRIPTION",
      error: isEnglish ? "You already have a monthly subscription. Manage it from billing settings." : "이미 월간 구독이 있습니다. 결제 관리에서 확인해 주세요.",
    }, { status: 409 });
  }

  try {
    const priceId = paddlePriceId(body.plan, Boolean(account?.trial_used_at));
    const transaction = await paddleRequest<Transaction>("/transactions", {
      method: "POST",
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        collection_mode: "automatic",
        customer_id: account?.paddle_customer_id ?? undefined,
        custom_data: { lecue_user_id: userId, plan_code: body.plan },
      }),
    });
    return NextResponse.json({ transactionId: transaction.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Checkout creation failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: isEnglish ? "Could not open checkout. Try again." : "결제창을 열지 못했습니다. 다시 시도해 주세요." }, { status: 503 });
  }
}
