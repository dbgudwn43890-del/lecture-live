import test from "node:test";
import assert from "node:assert/strict";
import { comparisonCurrency, localizedPrices, monthlyPriceComparison, pricePreviewItems, type PricePreviewResult } from "./paddle-pricing.ts";
import { PLANS } from "./plans.ts";

const ids = { monthly: "pri_monthly", semester: "pri_semester" };
function preview(currency: string, formatted: string, total: string): PricePreviewResult {
  return { data: { currencyCode: currency, details: { lineItems: [
    { price: { id: "pri_monthly" }, quantity: 1, totals: { total }, formattedTotals: { total: formatted } },
  ] } } };
}

test("pricing request uses catalog IDs without inferring currency from UI language", () => {
  assert.deepEqual(pricePreviewItems(ids), [{ priceId: "pri_monthly", quantity: 1 }, { priceId: "pri_semester", quantity: 1 }]);
  assert.deepEqual(pricePreviewItems({}), []);
});

test("USD, CAD and zero-decimal KRW preserve Paddle's exact formatted amount", () => {
  for (const [currency, formattedTotal, total] of [["USD", "$9.99", "999"], ["CAD", "CA$13.79", "1379"], ["KRW", "₩13,900", "13900"]]) {
    assert.deepEqual(localizedPrices(preview(currency, formattedTotal, total), { monthly: ids.monthly }).monthly, { currency, formattedTotal, total });
  }
});

test("prices map by price ID rather than the response order", () => {
  const result = preview("USD", "$9.99", "999");
  result.data.details.lineItems.unshift({ price: { id: ids.semester }, quantity: 1, totals: { total: "3399" }, formattedTotals: { total: "$33.99" } });
  const prices = localizedPrices(result, ids);
  assert.equal(prices.monthly?.formattedTotal, "$9.99");
  assert.equal(prices.semester?.formattedTotal, "$33.99");
});

test("missing, duplicate, or wrong-quantity prices cannot enable checkout", () => {
  assert.throws(() => localizedPrices(preview("USD", "$9.99", "999"), ids));
  const duplicate = preview("USD", "$9.99", "999");
  duplicate.data.details.lineItems.push(duplicate.data.details.lineItems[0]);
  assert.throws(() => localizedPrices(duplicate, { monthly: ids.monthly }));
  const quantity = preview("USD", "$19.98", "1998");
  quantity.data.details.lineItems[0].quantity = 2;
  assert.throws(() => localizedPrices(quantity, { monthly: ids.monthly }));
});

test("malformed totals and empty display amounts are rejected", () => {
  for (const [currency, formatted, total] of [["usd", "$9.99", "999"], ["USD", "", "999"], ["USD", "$9.99", "9.99"]]) {
    assert.throws(() => localizedPrices(preview(currency, formatted, total), { monthly: ids.monthly }));
  }
});

test("CAD and tax-adjusted USD never show a fabricated USD/KRW discount comparison", () => {
  assert.equal(comparisonCurrency("monthly", { currency: "CAD", total: "1379", formattedTotal: "CA$13.79" }), null);
  assert.equal(comparisonCurrency("monthly", { currency: "USD", total: "1087", formattedTotal: "$10.87" }), null);
  assert.equal(comparisonCurrency("monthly", { currency: "USD", total: String(Math.round(PLANS.monthly.usd * 100)), formattedTotal: "$9.99" }), "USD");
  assert.equal(comparisonCurrency("monthly", { currency: "KRW", total: String(PLANS.monthly.krw), formattedTotal: "₩13,900" }), "KRW");
});

test("USD comparison uses the real Monthly total across the term without changing the charge display", () => {
  const price = { currency: "USD", total: "3399", formattedTotal: "$33.99 incl. tax" };
  const monthly = { currency: "USD", total: "999", formattedTotal: "$9.99" };
  assert.deepEqual(monthlyPriceComparison(price, monthly, 4, "en"), { percent: 15, formattedTotal: "$39.96" });
  assert.equal(price.formattedTotal, "$33.99 incl. tax");
});

test("KRW and JPY comparisons retain zero-decimal minor units", () => {
  assert.deepEqual(monthlyPriceComparison(
    { currency: "KRW", total: "46900", formattedTotal: "₩46,900" },
    { currency: "KRW", total: "13900", formattedTotal: "₩13,900" },
    4, "ko",
  ), { percent: 16, formattedTotal: "₩55,600" });
  assert.deepEqual(monthlyPriceComparison(
    { currency: "JPY", total: "6000", formattedTotal: "￥6,000" },
    { currency: "JPY", total: "1200", formattedTotal: "￥1,200" },
    6, "en",
  ), { percent: 17, formattedTotal: "¥7,200" });
});

test("CAD comparison uses the actual tax-inclusive preview totals", () => {
  assert.deepEqual(monthlyPriceComparison(
    { currency: "CAD", total: "4691", formattedTotal: "CA$46.91" },
    { currency: "CAD", total: "1558", formattedTotal: "CA$15.58" },
    4, "en",
  ), { percent: 25, formattedTotal: "CA$62.32" });
});

test("EUR comparison retains two-decimal minor units", () => {
  assert.deepEqual(monthlyPriceComparison(
    { currency: "EUR", total: "9900", formattedTotal: "€99.00" },
    { currency: "EUR", total: "1000", formattedTotal: "€10.00" },
    12, "en",
  ), { percent: 18, formattedTotal: "€120.00" });
});

test("missing or mismatched currency prices cannot produce a comparison", () => {
  const price = { currency: "USD", total: "3399", formattedTotal: "$33.99" };
  const monthly = { currency: "USD", total: "999", formattedTotal: "$9.99" };
  assert.equal(monthlyPriceComparison(undefined, monthly, 4, "en"), null);
  assert.equal(monthlyPriceComparison(price, undefined, 4, "en"), null);
  assert.equal(monthlyPriceComparison(price, { ...monthly, currency: "CAD" }, 4, "en"), null);
});

test("invalid totals or month counts cannot produce a comparison", () => {
  const price = { currency: "USD", total: "3399", formattedTotal: "$33.99" };
  const monthly = { currency: "USD", total: "999", formattedTotal: "$9.99" };
  for (const total of ["", " ", "-1", "0", "1.5", "999.0", "NaN", "Infinity", "9007199254740992"]) {
    assert.equal(monthlyPriceComparison({ ...price, total }, monthly, 4, "en"), null, total);
    assert.equal(monthlyPriceComparison(price, { ...monthly, total }, 4, "en"), null, total);
  }
  for (const months of [-1, 0, 1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(monthlyPriceComparison(price, monthly, months, "en"), null, String(months));
  }
  assert.equal(monthlyPriceComparison(price, { ...monthly, total: String(Number.MAX_SAFE_INTEGER) }, 4, "en"), null);
});

test("equal or higher term totals do not claim savings", () => {
  const monthly = { currency: "USD", total: "1000", formattedTotal: "$10.00" };
  for (const total of ["4000", "4500"]) {
    assert.equal(monthlyPriceComparison({ currency: "USD", total, formattedTotal: "$40.00" }, monthly, 4, "en"), null);
  }
});
