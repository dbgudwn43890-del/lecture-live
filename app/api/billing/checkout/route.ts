import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "../../../lib/auth";
import { paddleRequest, PaddleApiError } from "../../../lib/billing";
import { billingMode, purchasePriceId, sameOrigin } from "../../../lib/billing-config";
import { PLANS, ENTITLEMENT_VERSION, isPurchasePlan } from "../../../lib/plans";
import { checkSharedRateLimit } from "../../../lib/rate-limit";
import { createAdminClient } from "../../../lib/supabase/admin";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const en = request.headers.get("x-site-locale") === "en";
  const fail = (status: number, ko: string, english: string) => NextResponse.json({ error: en ? english : ko }, { status });
  if (!sameOrigin(request)) return fail(403, "페이지를 새로고침한 뒤 다시 시도해 주세요.", "Refresh the page and try again.");
  const userId = await getAuthenticatedUserId();
  if (!userId) return fail(401, "로그인이 필요합니다.", "Sign in to continue.");
  const mode = billingMode();
  if (mode === "disabled") return fail(503, "결제를 준비하고 있습니다. 무료 체험은 이용할 수 있어요.", "Payments are not available yet. You can still try Lecue free.");
  const limit = await checkSharedRateLimit(`billing-checkout:${userId}`, 6, 60_000);
  if (!limit.allowed) return fail(429, "잠시 후 다시 시도해 주세요.", "Please try again shortly.");
  const body = await request.json().catch(() => null) as { plan?: unknown } | null;
  if (!body || !isPurchasePlan(body.plan)) return fail(400, "플랜을 선택해 주세요.", "Choose a plan.");
  const plan = body.plan;
  const offer = PLANS[plan];
  const priceId = purchasePriceId(plan);
  // 카탈로그에 아직 없는 플랜. 카드는 "준비 중"으로 막혀 있지만 직접 호출도 막는다.
  if (!priceId) return fail(503, "이 플랜은 준비 중입니다.", "This plan is not available yet.");
  const admin = createAdminClient();
  if (!admin) return fail(503, "결제를 준비하고 있습니다.", "Payments are not available yet.");
  let reservedId: string | null = null;
  let providerStarted = false;
  try {
    const price = await paddleRequest<{ status: string; unit_price: { amount: string; currency_code: string }; billing_cycle: { interval: string; frequency: number } | null; trial_period: unknown; unit_price_overrides: { country_codes: string[]; unit_price: { amount: string; currency_code: string } }[] }>(`/prices/${priceId}`);
    const kr = price.unit_price_overrides.find(item => item.country_codes.includes("KR"))?.unit_price;
    if (price.status !== "active" || price.unit_price.currency_code !== "USD" || Number(price.unit_price.amount) !== Math.round(offer.usd * 100) || Number(kr?.amount) !== offer.krw || kr?.currency_code !== "KRW" || price.trial_period || (offer.recurring ? price.billing_cycle?.interval !== "month" || price.billing_cycle.frequency !== 1 : price.billing_cycle !== null)) throw new Error("CATALOG_MISMATCH");
    const id = randomUUID();
    const { data: rows, error } = await admin.rpc("reserve_billing_order", {
      p_id: id, p_user_id: userId, p_plan: plan, p_price_id: priceId,
      p_credits: offer.credits, p_months: offer.months, p_environment: mode,
      p_entitlement_version: ENTITLEMENT_VERSION,
    });
    if (error?.message.includes("ACTIVE_SUBSCRIPTION")) return fail(409, "Monthly를 이미 이용 중입니다. 결제 관리에서 확인해 주세요.", "Monthly is already active. Open billing management.");
    if (error?.message.includes("ACTIVE_PLAN")) return fail(409, "이용 중인 플랜이 있습니다. credits가 부족하면 추가 충전을 이용해 주세요.", "You already have an active plan. Add credits if you need more before your next refill.");
    if (error || !rows?.[0]) throw new Error("ORDER_RESERVATION_FAILED");
    const order = rows[0];
    if (order.price_id && (order.price_id !== priceId || order.credits !== offer.credits || order.months !== offer.months || order.entitlement_version !== ENTITLEMENT_VERSION)) {
      return fail(409, "이전 가격으로 진행 중인 결제가 있습니다. 결제 상태를 먼저 확인해 주세요.", "A checkout at an earlier price is pending. Check its payment status first.");
    }
    if (order.id === id) reservedId = id;
    if (order.id !== id && !order.transaction_id) {
      // Recover a transaction created before a timeout or a failed DB attachment.
      const recent = await paddleRequest<{ id: string; custom_data?: { lecue_order_id?: string } }[]>("/transactions?per_page=100");
      const recovered = recent.find(item => item.custom_data?.lecue_order_id === order.id);
      if (recovered) {
        const { error: recoverError } = await admin.from("billing_orders").update({ transaction_id: recovered.id }).eq("id", order.id).is("transaction_id", null);
        if (recoverError) throw new Error("ORDER_RECOVERY_FAILED");
        order.transaction_id = recovered.id;
      }
    }
    if (order.transaction_id) {
      const transaction = await paddleRequest<{ id: string; status: string }>(`/transactions/${order.transaction_id}`);
      if (!["draft", "ready"].includes(transaction.status)) return fail(409, "기존 결제를 확인 중입니다. 아래에서 결제 상태를 확인해 주세요.", "An earlier payment is being processed. Check its status below.");
      return NextResponse.json({ transactionId: transaction.id }, { headers: { "Cache-Control": "no-store" } });
    }
    if (order.id !== id) return fail(409, "이미 결제창을 준비 중입니다. 잠시 후 다시 시도해 주세요.", "Checkout is already being prepared. Try again shortly.");
    const { data: account, error: accountError } = await admin.from("billing_accounts").select("paddle_customer_id").eq("user_id", userId).maybeSingle();
    if (accountError) throw new Error("ACCOUNT_READ_FAILED");
    providerStarted = true;
    const transaction = await paddleRequest<{ id: string }>("/transactions", {
      method: "POST",
      body: JSON.stringify({ items: [{ price_id: priceId, quantity: 1 }], collection_mode: "automatic",
        customer_id: account?.paddle_customer_id ?? undefined, custom_data: { lecue_order_id: id },
      }),
    });
    const { error: attachError } = await admin.from("billing_orders").update({ transaction_id: transaction.id }).eq("id", id).is("transaction_id", null);
    if (attachError) throw new Error("ORDER_ATTACH_FAILED");
    return NextResponse.json({ transactionId: transaction.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // A known rejection is safe to retry; a timeout may have created a real
    // transaction, so keep that reservation for recovery instead of duplicating it.
    if (reservedId && (!providerStarted || error instanceof PaddleApiError && error.status >= 400 && error.status < 500)) {
      await admin.from("billing_orders").update({ failed_at: new Date().toISOString() }).eq("id", reservedId).is("transaction_id", null);
    }
    console.error("Checkout creation failed", error instanceof Error ? error.message : "unknown");
    return fail(503, "결제창을 열지 못했습니다. 잠시 후 다시 시도하거나 support@lecue.app으로 알려주세요.", "Could not open checkout. Try again shortly or contact support@lecue.app.");
  }
}
