import assert from "node:assert/strict";
import test from "node:test";

import { PLANS, isPurchasePlan } from "./plans.ts";

test("Korean acquisition pricing preserves overseas base prices and entitlements", () => {
  assert.deepEqual(Object.values(PLANS).map(({ krw }) => krw), [7900, 27900, 39900, 74900, 5900]);
  assert.deepEqual(Object.values(PLANS).map(({ usd }) => usd), [9.99, 35.99, 51.99, 99.99, 5.99]);
  assert.deepEqual(Object.values(PLANS).map(({ credits }) => credits), [2400, 9600, 14400, 28800, 1000]);
});

test("prepaying more buys cheaper credits, and a top-up never undercuts Monthly", () => {
  for (const currency of ["usd", "krw"] as const) {
    const perCredit = (plan: keyof typeof PLANS) => PLANS[plan][currency] / PLANS[plan].credits;
    assert.ok(perCredit("annual") < perCredit("halfyear"), `${currency}: Annual must be the cheapest per credit`);
    assert.ok(perCredit("halfyear") < perCredit("semester"), `${currency}: Half-year must beat Semester per credit`);
    assert.ok(perCredit("semester") < perCredit("monthly"), `${currency}: Semester must beat Monthly per credit`);
    assert.ok(perCredit("monthly") <= perCredit("topup") * 0.75, `${currency}: Monthly must offer meaningful value over Top-up`);
  }
});

test("prepaid plans buy monthly installments, not a larger first-month allowance", () => {
  for (const key of ["monthly", "semester", "halfyear", "annual"] as const) {
    const plan = PLANS[key];
    assert.equal(plan.monthlyCredits, 2400);
    assert.equal(plan.installmentCount, plan.months);
    assert.equal(plan.credits, plan.monthlyCredits * plan.installmentCount);
  }
  assert.equal(PLANS.semester.installmentCount, 4);
  assert.equal(PLANS.halfyear.installmentCount, 6);
  assert.equal(PLANS.annual.installmentCount, 12);
  assert.deepEqual(Object.entries(PLANS).filter(([, plan]) => plan.recurring).map(([key]) => key), ["monthly"]);
  assert.equal(PLANS.topup.installmentCount, 1);
  assert.equal(PLANS.topup.monthlyCredits, null);
});

test("plan validation rejects legacy and unknown codes", () => {
  assert.ok(isPurchasePlan("annual") && isPurchasePlan("topup"));
  assert.ok(!isPurchasePlan("term") && !isPurchasePlan("trial") && !isPurchasePlan("__proto__") && !isPurchasePlan(null));
});
