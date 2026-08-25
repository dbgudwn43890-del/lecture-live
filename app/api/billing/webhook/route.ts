import { NextResponse } from "next/server";

import { addUtcMonths, type BillingPlan, isBillingPlan, isUuid, PLAN_CREDITS, verifyPaddleSignature } from "../../../lib/billing";
import { createAdminClient } from "../../../lib/supabase/admin";

export const runtime = "nodejs";

type PaddleEvent = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
};

type CustomData = { lecue_user_id?: unknown; plan_code?: unknown };
type Period = { starts_at?: unknown; ends_at?: unknown } | null;
type PriceItem = { price?: { id?: unknown } };

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function date(value: unknown) {
  const candidate = text(value);
  return candidate && !Number.isNaN(new Date(candidate).valueOf()) ? candidate : null;
}

function identity(data: Record<string, unknown>) {
  const custom = data.custom_data as CustomData | null;
  if (!custom || !isUuid(custom.lecue_user_id) || !isBillingPlan(custom.plan_code)) return null;
  return { userId: custom.lecue_user_id, plan: custom.plan_code };
}

function hasExpectedPrice(data: Record<string, unknown>, plan: BillingPlan) {
  const configured = plan === "term"
    ? [process.env.PADDLE_TERM_PRICE_ID]
    : plan === "semester"
      ? [process.env.PADDLE_SEMESTER_PRICE_ID]
      : [process.env.PADDLE_MONTHLY_PRICE_ID, process.env.PADDLE_MONTHLY_NO_TRIAL_PRICE_ID];
  const allowed = new Set(configured.filter(Boolean));
  const items = Array.isArray(data.items) ? data.items as PriceItem[] : [];
  return allowed.size > 0 && items.some((item) => allowed.has(text(item.price?.id) ?? ""));
}

async function syncSubscription(admin: NonNullable<ReturnType<typeof createAdminClient>>, event: PaddleEvent) {
  const data = event.data;
  const owner = identity(data);
  if (!owner || owner.plan !== "monthly" || !hasExpectedPrice(data, "monthly")) return;
  const subscriptionId = text(data.id);
  const customerId = text(data.customer_id);
  const status = text(data.status);
  const allowedStatuses = ["trialing", "active", "past_due", "paused", "canceled"];
  if (!subscriptionId || !customerId || !status || !allowedStatuses.includes(status)) return;

  const period = data.current_billing_period as Period;
  const scheduled = data.scheduled_change as { action?: unknown; effective_at?: unknown } | null;
  const trialUsedAt = event.event_type === "subscription.created"
    ? date(data.started_at) ?? event.occurred_at
    : status === "trialing"
      ? date(data.started_at) ?? event.occurred_at
      : null;
  const { error } = await admin.rpc("sync_billing_account", {
    p_user_id: owner.userId,
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
    p_status: status,
    p_period_starts_at: date(period?.starts_at),
    p_period_ends_at: date(period?.ends_at),
    p_next_billed_at: date(data.next_billed_at),
    p_scheduled_cancel_at: scheduled?.action === "cancel" ? date(scheduled.effective_at) : null,
    p_trial_used_at: trialUsedAt,
    p_event_at: date(data.updated_at) ?? event.occurred_at,
  });
  if (error) throw new Error(`billing account sync: ${error.code}`);

  if (status === "trialing") {
    const startsAt = date(data.started_at) ?? date(period?.starts_at) ?? event.occurred_at;
    const expiresAt = date(data.next_billed_at) ?? date(period?.ends_at) ?? new Date(new Date(startsAt).valueOf() + 7 * 86_400_000).toISOString();
    const { error: grantError } = await admin.from("credit_grants").upsert({
      user_id: owner.userId,
      source_type: "trial",
      source_id: owner.userId,
      plan_code: "trial",
      granted_credits: PLAN_CREDITS.trial,
      remaining_credits: PLAN_CREDITS.trial,
      starts_at: startsAt,
      expires_at: expiresAt,
    }, { onConflict: "source_type,source_id", ignoreDuplicates: true });
    if (grantError) throw new Error(`trial grant: ${grantError.code}`);
  }
}

async function grantPaidCredits(admin: NonNullable<ReturnType<typeof createAdminClient>>, event: PaddleEvent) {
  const data = event.data;
  const owner = identity(data);
  if (!owner || !hasExpectedPrice(data, owner.plan)) return;
  const transactionId = text(data.id);
  const customerId = text(data.customer_id);
  const totals = (data.details as { totals?: { grand_total?: unknown } } | null)?.totals;
  if (!transactionId || Number(text(totals?.grand_total) ?? "0") <= 0) return;

  const period = data.billing_period as Period;
  const startsAt = date(period?.starts_at) ?? date(data.billed_at) ?? event.occurred_at;
  const expiresAt = owner.plan === "monthly"
    ? date(period?.ends_at) ?? addUtcMonths(startsAt, 1)
    : addUtcMonths(startsAt, owner.plan === "term" ? 4 : 6);
  const credits = PLAN_CREDITS[owner.plan];
  const { error } = await admin.from("credit_grants").upsert({
    user_id: owner.userId,
    source_type: "payment",
    source_id: transactionId,
    plan_code: owner.plan,
    granted_credits: credits,
    remaining_credits: credits,
    starts_at: startsAt,
    expires_at: expiresAt,
  }, { onConflict: "source_type,source_id", ignoreDuplicates: true });
  if (error) throw new Error(`paid grant: ${error.code}`);

  if (customerId) {
    const { data: account, error: readError } = await admin
      .from("billing_accounts")
      .select("user_id")
      .eq("user_id", owner.userId)
      .maybeSingle();
    if (readError) throw new Error(`customer lookup: ${readError.code}`);
    const accountWrite = account
      ? admin.from("billing_accounts").update({ paddle_customer_id: customerId }).eq("user_id", owner.userId)
      : admin.from("billing_accounts").insert({
          user_id: owner.userId,
          paddle_customer_id: customerId,
          last_event_at: "1970-01-01T00:00:00.000Z",
        });
    const { error: accountError } = await accountWrite;
    if (accountError) throw new Error(`customer sync: ${accountError.code}`);
  }
}

async function revokeRefundedCredits(admin: NonNullable<ReturnType<typeof createAdminClient>>, event: PaddleEvent) {
  const action = text(event.data.action);
  const status = text(event.data.status);
  const transactionId = text(event.data.transaction_id);
  if (!transactionId || status !== "approved" || !["refund", "chargeback"].includes(action ?? "")) return;
  const { error } = await admin.from("credit_grants").update({
    remaining_credits: 0,
    revoked_at: event.occurred_at,
    updated_at: new Date().toISOString(),
  }).eq("source_type", "payment").eq("source_id", transactionId).is("revoked_at", null);
  if (error) throw new Error(`credit revocation: ${error.code}`);
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("paddle-signature") ?? "";
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 });
  if (!verifyPaddleSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: PaddleEvent;
  try {
    event = JSON.parse(rawBody) as PaddleEvent;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  if (!text(event.event_id) || !text(event.event_type) || !date(event.occurred_at) || !event.data || typeof event.data !== "object") {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Billing storage is not configured" }, { status: 503 });
  const { data: processed, error: readError } = await admin.from("billing_webhook_events").select("event_id").eq("event_id", event.event_id).maybeSingle();
  if (readError) return NextResponse.json({ error: "Billing storage is not ready" }, { status: 503 });
  if (processed) return NextResponse.json({ received: true });

  try {
    if ([
      "subscription.created",
      "subscription.trialing",
      "subscription.activated",
      "subscription.updated",
      "subscription.past_due",
      "subscription.canceled",
      "subscription.paused",
      "subscription.resumed",
    ].includes(event.event_type)) {
      await syncSubscription(admin, event);
    } else if (event.event_type === "transaction.completed") {
      await grantPaidCredits(admin, event);
    } else if (event.event_type === "adjustment.updated") {
      await revokeRefundedCredits(admin, event);
    }
    const { error } = await admin.from("billing_webhook_events").insert({
      event_id: event.event_id,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
    });
    if (error && error.code !== "23505") throw new Error(`event record: ${error.code}`);
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Paddle webhook processing failed", event.event_type, error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
