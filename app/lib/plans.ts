export const PLANS = {
  monthly: { name: "Monthly", credits: 3_000, months: 1, usd: 9.99, krw: 13_900, recurring: true },
  semester: { name: "Semester", credits: 12_000, months: 4, usd: 39.96, krw: 55_600, recurring: false },
} as const;
export type PurchasePlan = keyof typeof PLANS;
export function isPurchasePlan(value: unknown): value is PurchasePlan {
  return value === "monthly" || value === "semester";
}
export const STARTER_CREDITS = 300;
export const STARTER_DAYS = 14;
