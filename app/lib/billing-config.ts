import { PLANS, PURCHASE_PLANS, type PurchasePlan } from "./plans.ts";

const PRICE_ENV: Record<PurchasePlan, string> = {
  monthly: "PADDLE_MONTHLY_V3_PRICE_ID",
  semester: "PADDLE_SEMESTER_V3_PRICE_ID",
  halfyear: "PADDLE_HALFYEAR_V3_PRICE_ID",
  annual: "PADDLE_ANNUAL_V3_PRICE_ID",
  topup: "PADDLE_TOPUP_V3_PRICE_ID",
};

// Separate price IDs preserve the entitlements of earlier purchases.
export function purchasePriceId(plan: PurchasePlan) {
  return process.env[PRICE_ENV[plan]];
}

/** 카탈로그에 price ID가 있는 플랜만. 없는 플랜은 카드에 "준비 중"으로 뜬다. */
export function availablePlans(): PurchasePlan[] {
  return PURCHASE_PLANS.filter((plan) => purchasePriceId(plan));
}

export function billingMode(): "sandbox" | "live" | "disabled" {
  const environment = process.env.PADDLE_ENVIRONMENT;
  if (process.env.BILLING_ENABLED !== "true" || !process.env.PADDLE_API_KEY || !process.env.PADDLE_WEBHOOK_SECRET) return "disabled";
  // 플랜을 하나씩 추가할 수 있게 전부가 아니라 하나 이상을 요구한다.
  if (!availablePlans().length) return "disabled";
  if (process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT !== environment) return "disabled";
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "";
  const apiKey = process.env.PADDLE_API_KEY;
  if (environment === "sandbox" && token.startsWith("test_") && apiKey.startsWith("pdl_sdbx_") && process.env.VERCEL_ENV !== "production") return "sandbox";
  if (environment === "production" && token.startsWith("live_") && apiKey.startsWith("pdl_live_")) return "live";
  return "disabled";
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin;
}

export { PLANS };
