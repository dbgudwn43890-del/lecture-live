import { createHmac, timingSafeEqual } from "node:crypto";

export type BillingPlan = "monthly" | "term" | "semester";

export const PLAN_CREDITS = {
  trial: 180,
  monthly: 4_200,
  term: 16_800,
  semester: 25_200,
} as const;

export function isBillingPlan(value: unknown): value is BillingPlan {
  return value === "monthly" || value === "term" || value === "semester";
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function addUtcMonths(value: string, months: number) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid billing date");
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

export function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const parts = signatureHeader.split(";").map((part) => part.split("=", 2));
  const timestamp = parts.find(([key]) => key === "ts")?.[1];
  const signatures = parts.filter(([key]) => key === "h1").map(([, value]) => value);
  const eventSeconds = Number(timestamp);
  // 300s is Paddle's own documented replay window. At 30s a cold start plus
  // reading a large transaction.completed body could age the delivery past the
  // limit, rejecting a real payment and leaving the buyer's credits waiting on
  // Paddle's retry. Replay protection comes from billing_webhook_events, not
  // from a tight clock.
  if (!timestamp || !Number.isInteger(eventSeconds) || Math.abs(nowSeconds - eventSeconds) > 300 || signatures.length === 0) {
    return false;
  }

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}:${rawBody}`, "utf8").digest("hex"),
    "hex",
  );
  return signatures.some((signature) => {
    const actual = Buffer.from(signature, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export function paddlePriceId(plan: BillingPlan, trialUsed: boolean) {
  const key = plan === "term"
    ? "PADDLE_TERM_PRICE_ID"
    : plan === "semester"
      ? "PADDLE_SEMESTER_PRICE_ID"
      : trialUsed
        ? "PADDLE_MONTHLY_NO_TRIAL_PRICE_ID"
        : "PADDLE_MONTHLY_PRICE_ID";
  const priceId = process.env[key];
  if (!priceId) throw new Error(`${key} is not configured`);
  return priceId;
}

export function paddleApiBase() {
  return process.env.PADDLE_ENVIRONMENT === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";
}

export async function paddleRequest<T>(path: string, init: RequestInit = {}) {
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) throw new Error("PADDLE_API_KEY is not configured");
  const response = await fetch(`${paddleApiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    cache: "no-store",
    // Without this a hung Paddle call rides to the platform function timeout.
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as { data?: T; meta?: { request_id?: string }; error?: { code?: string } } | null;
  if (!response.ok || !payload?.data) {
    console.error("Paddle API request failed", response.status, payload?.error?.code ?? "unknown", payload?.meta?.request_id ?? "");
    throw new Error("Paddle API request failed");
  }
  return payload.data;
}
