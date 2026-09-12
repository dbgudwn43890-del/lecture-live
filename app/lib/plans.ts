/**
 * Monthly renews automatically; Semester/Annual prepay monthly installments.
 * credits is the total purchased entitlement, not the amount available today.
 * Existing orders keep their immutable price/quantity/version snapshot.
 * Paddle 카탈로그와 반드시 일치해야 한다(checkout이 CATALOG_MISMATCH로 막는다).
 */
export const PLANS = {
  monthly: { name: "Monthly", credits: 2_400, monthlyCredits: 2_400, installmentCount: 1, months: 1, usd: 9.99, krw: 7_900, recurring: true },
  semester: { name: "Semester", credits: 9_600, monthlyCredits: 2_400, installmentCount: 4, months: 4, usd: 35.99, krw: 27_900, recurring: false },
  halfyear: { name: "Half-year", credits: 14_400, monthlyCredits: 2_400, installmentCount: 6, months: 6, usd: 51.99, krw: 39_900, recurring: false },
  annual: { name: "Annual", credits: 28_800, monthlyCredits: 2_400, installmentCount: 12, months: 12, usd: 99.99, krw: 74_900, recurring: false },
  topup: { name: "Top-up", credits: 1_000, monthlyCredits: null, installmentCount: 1, months: 12, usd: 5.99, krw: 5_900, recurring: false },
} as const;
export type PurchasePlan = keyof typeof PLANS;
export const PURCHASE_PLANS = Object.keys(PLANS) as PurchasePlan[];
export const ENTITLEMENT_VERSION = "monthly_v1";
export function isPurchasePlan(value: unknown): value is PurchasePlan {
  // `in`은 프로토타입 체인("__proto__", "constructor")까지 통과시킨다.
  return typeof value === "string" && Object.hasOwn(PLANS, value);
}
export const STARTER_CREDITS = 600;
export const STARTER_DAYS = 14;
