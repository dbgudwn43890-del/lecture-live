import { PLANS, type PurchasePlan } from "./plans";

// Separate price IDs preserve the entitlements of earlier purchases.
export function purchasePriceId(plan: PurchasePlan) {
  return process.env[plan === "monthly" ? "PADDLE_MONTHLY_V2_PRICE_ID" : "PADDLE_SEMESTER_V2_PRICE_ID"];
}

export function billingMode(): "sandbox" | "live" | "disabled" {
  const environment = process.env.PADDLE_ENVIRONMENT;
  if (process.env.BILLING_ENABLED !== "true" || !process.env.PADDLE_API_KEY || !process.env.PADDLE_WEBHOOK_SECRET) return "disabled";
  if (!Object.keys(PLANS).every(plan => purchasePriceId(plan as PurchasePlan))) return "disabled";
  if (process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT !== environment) return "disabled";
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "";
  if (environment === "sandbox" && token.startsWith("test_") && process.env.VERCEL_ENV !== "production") return "sandbox";
  if (environment === "production" && token.startsWith("live_")) return "live";
  return "disabled";
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin;
}
