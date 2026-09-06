import assert from "node:assert/strict";
import test from "node:test";

import { PLANS, discountPercent, isPurchasePlan } from "./plans.ts";

const perCredit = (plan: keyof typeof PLANS) => PLANS[plan].krw / PLANS[plan].credits;

test("prepaying more buys cheaper credits, and a top-up never undercuts Monthly", () => {
  // 사다리가 깨지면 사용자가 상위 플랜으로 올라갈 이유가 사라진다.
  assert.ok(perCredit("annual") < perCredit("semester"), "annual must be the cheapest per credit");
  assert.ok(perCredit("semester") < perCredit("monthly"), "semester must beat monthly per credit");
  assert.ok(perCredit("topup") >= perCredit("monthly"), "a top-up must not be cheaper than subscribing");
});

test("every promo price sits below its struck list price, USD and KRW alike", () => {
  for (const [key, plan] of Object.entries(PLANS)) {
    assert.ok(plan.krw < plan.listKrw, `${key} krw`);
    assert.ok(plan.usd < plan.listUsd, `${key} usd`);
    assert.ok(discountPercent(key as keyof typeof PLANS) >= 30, `${key} discount reads as a real launch deal`);
  }
});

test("plan validation rejects legacy and unknown codes", () => {
  assert.ok(isPurchasePlan("annual") && isPurchasePlan("topup"));
  assert.ok(!isPurchasePlan("term") && !isPurchasePlan("trial") && !isPurchasePlan("__proto__") && !isPurchasePlan(null));
});
