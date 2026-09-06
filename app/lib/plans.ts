/**
 * 판매 플랜. 원칙: 자동 갱신은 Monthly 하나뿐, 선결제할수록 크레딧당 단가가
 * 내려가는 사다리(Top-up > Monthly > Semester > Annual), 헤비유저는 Top-up.
 * list*는 "프로모션 종료 후 예정가" — 취소선 앵커. 실제 청구는 usd/krw.
 * Paddle 카탈로그와 반드시 일치해야 한다(checkout이 CATALOG_MISMATCH로 막는다).
 */
export const PLANS = {
  monthly: { name: "Monthly", credits: 2_400, months: 1, usd: 9.99, krw: 13_900, listUsd: 15.99, listKrw: 22_900, recurring: true },
  semester: { name: "Semester", credits: 10_000, months: 4, usd: 33.99, krw: 46_900, listUsd: 56.99, listKrw: 79_000, recurring: false },
  annual: { name: "Annual", credits: 24_000, months: 12, usd: 78.99, krw: 109_000, listUsd: 135.99, listKrw: 189_000, recurring: false },
  topup: { name: "Top-up", credits: 1_000, months: 12, usd: 4.29, krw: 5_900, listUsd: 6.99, listKrw: 9_900, recurring: false },
} as const;
export type PurchasePlan = keyof typeof PLANS;
export const PURCHASE_PLANS = Object.keys(PLANS) as PurchasePlan[];
export function isPurchasePlan(value: unknown): value is PurchasePlan {
  // `in`은 프로토타입 체인("__proto__", "constructor")까지 통과시킨다.
  return typeof value === "string" && Object.hasOwn(PLANS, value);
}
/** 취소선 대비 할인율(%). 표시 전용. */
export function discountPercent(plan: PurchasePlan) {
  const { krw, listKrw } = PLANS[plan];
  return Math.round((1 - krw / listKrw) * 100);
}
export const STARTER_CREDITS = 600;
export const STARTER_DAYS = 14;
