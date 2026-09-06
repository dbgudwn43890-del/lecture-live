import { NextResponse } from "next/server";
import { addUtcMonths, isUuid, verifyPaddleSignature, paddleRequest, PLAN_CREDITS, isBillingPlan } from "../../../lib/billing";
import { createAdminClient } from "../../../lib/supabase/admin";

export const runtime = "nodejs";
type Data = Record<string, any>;
const validDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const amount = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

async function entitlement(admin: NonNullable<ReturnType<typeof createAdminClient>>, data: Data, subscription: boolean) {
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length !== 1 || items[0].quantity !== 1) return null;
  const priceId = items[0].price?.id;
  const orderId = data.custom_data?.lecue_order_id;
  if (isUuid(orderId)) {
    const { data: order, error } = await admin.from("billing_orders").select("*").eq("id", orderId).maybeSingle();
    if (error) throw new Error("Order lookup failed");
    if (!order || order.price_id !== priceId || order.environment !== (process.env.PADDLE_ENVIRONMENT === "sandbox" ? "sandbox" : "live")) return null;
    if (!order.transaction_id) throw new Error("Order still attaching");
    // Initial checkout must be the transaction we created. Renewals must belong
    // to that transaction's subscription, never merely copy its custom_data.
    if (subscription || order.transaction_id !== data.id) {
      const original = await paddleRequest<Data>(`/transactions/${order.transaction_id}`);
      if (!original.subscription_id) throw new Error("Subscription still attaching");
      if (original.subscription_id !== (subscription ? data.id : data.subscription_id) || original.customer_id !== data.customer_id) return null;
    }
    return { userId: order.user_id, plan: order.plan_code, credits: order.credits, months: order.months, trial: false };
  }
  // Existing purchases keep the old entitlement, but only a previously bound
  // customer may receive legacy renewal events. New checkout never uses these IDs.
  const custom = data.custom_data as { lecue_user_id?: unknown; plan_code?: unknown } | null;
  if (!isUuid(custom?.lecue_user_id) || !isBillingPlan(custom?.plan_code)) return null;
  const plan = custom.plan_code;
  const ids = plan === "monthly" ? [process.env.PADDLE_MONTHLY_PRICE_ID, process.env.PADDLE_MONTHLY_NO_TRIAL_PRICE_ID]
    : [process.env[plan === "term" ? "PADDLE_TERM_PRICE_ID" : "PADDLE_SEMESTER_PRICE_ID"]];
  if (!priceId || !ids.filter(Boolean).includes(priceId)) return null;
  const { data: account, error } = await admin.from("billing_accounts").select("paddle_customer_id,paddle_subscription_id").eq("user_id", custom.lecue_user_id).maybeSingle();
  if (error) throw new Error("Legacy account lookup failed");
  if (!account || account.paddle_customer_id !== data.customer_id || (plan === "monthly" && account.paddle_subscription_id !== (subscription ? data.id : data.subscription_id))) return null;
  return { userId: custom.lecue_user_id, plan, credits: PLAN_CREDITS[plan], months: plan === "monthly" ? 1 : plan === "term" ? 4 : 6, trial: true };
}

export async function POST(request: Request) {
  const raw = await request.text();
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  if (!verifyPaddleSignature(raw, request.headers.get("paddle-signature") ?? "", secret)) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  let event: Data;
  try { event = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid payload" }, { status: 400 }); }
  if (!event || typeof event.event_id !== "string" || !event.event_id || typeof event.event_type !== "string" || !validDate(event.occurred_at) || !event.data || Array.isArray(event.data) || typeof event.data !== "object") return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });
  try {
    let grant: Data | null = null, account: Data | null = null, adjustment: Data | null = null;
    const data = event.data;
    if (event.event_type === "transaction.completed" && data.status === "completed") {
      const owner = await entitlement(admin, data, false);
      const totalBeforeDiscount = amount(data.details?.totals?.subtotal);
      const discount = amount(data.details?.totals?.discount ?? "0");
      const subtotal = totalBeforeDiscount !== null && discount !== null ? totalBeforeDiscount - discount : null;
      const total = amount(data.details?.totals?.grand_total);
      if (owner && typeof data.id === "string" && subtotal && subtotal > 0 && total) {
        const start = validDate(data.billing_period?.starts_at) ? data.billing_period.starts_at : validDate(data.billed_at) ? data.billed_at : event.occurred_at;
        const end = owner.plan === "monthly" && validDate(data.billing_period?.ends_at) ? data.billing_period.ends_at : addUtcMonths(start, owner.months);
        grant = { user_id: owner.userId, source_type: "payment", source_id: data.id, plan_code: owner.plan,
          credits: owner.credits, starts_at: start, expires_at: end, paid_subtotal: subtotal };
        if (typeof data.customer_id === "string") account = { user_id: owner.userId, customer_id: data.customer_id };
        if (account && owner.plan === "monthly" && typeof data.subscription_id === "string") {
          account = { ...account, subscription_id: data.subscription_id, status: "active", period_starts_at: start, period_ends_at: end,
            next_billed_at: end, scheduled_cancel_at: null, trial_used_at: null, event_at: event.occurred_at };
        }
      }
    } else if (event.event_type.startsWith("subscription.")) {
      const owner = await entitlement(admin, data, true);
      if (owner?.plan === "monthly" && typeof data.id === "string" && typeof data.customer_id === "string" && ["active", "trialing", "past_due", "paused", "canceled"].includes(data.status)) {
        account = { user_id: owner.userId, customer_id: data.customer_id, subscription_id: data.id, status: data.status,
          period_starts_at: validDate(data.current_billing_period?.starts_at) ? data.current_billing_period.starts_at : null,
          period_ends_at: validDate(data.current_billing_period?.ends_at) ? data.current_billing_period.ends_at : null,
          next_billed_at: validDate(data.next_billed_at) ? data.next_billed_at : null,
          scheduled_cancel_at: data.scheduled_change?.action === "cancel" && validDate(data.scheduled_change.effective_at) ? data.scheduled_change.effective_at : null,
          trial_used_at: data.status === "trialing" ? event.occurred_at : null,
          event_at: validDate(data.updated_at) ? data.updated_at : event.occurred_at };
        if (owner.trial && data.status === "trialing") grant = { user_id: owner.userId, source_type: "trial", source_id: owner.userId, plan_code: "trial", credits: PLAN_CREDITS.trial, starts_at: validDate(data.started_at) ? data.started_at : event.occurred_at, expires_at: data.next_billed_at };
      }
    } else if (["adjustment.created", "adjustment.updated"].includes(event.event_type) && data.status === "approved" && ["refund", "chargeback"].includes(data.action)) {
      const subtotal = amount(data.totals?.subtotal);
      if (typeof data.id !== "string" || typeof data.transaction_id !== "string" || subtotal === null) throw new Error("Invalid refund totals");
      adjustment = { id: data.id, transaction_id: data.transaction_id, subtotal };
    } else return NextResponse.json({ received: true });
    const { error } = await admin.rpc("apply_billing_event", { p_event_id: event.event_id, p_event_type: event.event_type, p_occurred_at: event.occurred_at, p_grant: grant, p_account: account, p_adjustment: adjustment });
    if (error) throw new Error(`Atomic billing failed: ${error.code}`);
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Paddle event processing failed", event.event_type, error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
