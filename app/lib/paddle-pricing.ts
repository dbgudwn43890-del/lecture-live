import { PLANS, PURCHASE_PLANS, type PurchasePlan } from "./plans.ts";

export type PaddlePriceIds = Partial<Record<PurchasePlan, string>>;
export type LocalizedPrice = { formattedTotal: string; currency: string; total: string };
export type LocalizedPrices = Partial<Record<PurchasePlan, LocalizedPrice>>;
export type PricePreviewResult = {
  data: {
    currencyCode: string;
    details: { lineItems: { price: { id: string }; quantity: number; totals: { total: string }; formattedTotals: { total: string } }[] };
  };
};

export function pricePreviewItems(ids: PaddlePriceIds) {
  return PURCHASE_PLANS.flatMap(plan => ids[plan] ? [{ priceId: ids[plan]!, quantity: 1 }] : []);
}

/** Display Paddle's formatted total unchanged; UI language must never select currency. */
export function localizedPrices(result: PricePreviewResult, ids: PaddlePriceIds): LocalizedPrices {
  const data = result?.data;
  if (!data || !/^[A-Z]{3}$/.test(data.currencyCode) || !Array.isArray(data.details?.lineItems)) throw new Error("INVALID_PRICE_PREVIEW");
  return Object.fromEntries(PURCHASE_PLANS.filter(plan => ids[plan]).map(plan => {
    const matching = data.details.lineItems.filter(item => item.price?.id === ids[plan]);
    const item = matching[0];
    if (matching.length !== 1 || item.quantity !== 1 || !/^\d+$/.test(item.totals?.total) || !item.formattedTotals?.total?.trim()) throw new Error("INCOMPLETE_PRICE_PREVIEW");
    return [plan, { formattedTotal: item.formattedTotals.total, currency: data.currencyCode, total: item.totals.total }];
  }));
}

/** Compare actual preview totals with Monthly over the same term and currency. */
export function monthlyPriceComparison(
  price: LocalizedPrice | undefined,
  monthly: LocalizedPrice | undefined,
  months: number,
  locale: "ko" | "en",
): { percent: number; formattedTotal: string } | null {
  if (!price || !monthly || price.currency !== monthly.currency || !/^[A-Z]{3}$/.test(price.currency)
    || !Number.isSafeInteger(months) || months <= 1
    || !/^\d+$/.test(price.total) || !/^\d+$/.test(monthly.total)) return null;
  const total = Number(price.total), monthlyTotal = Number(monthly.total);
  const baseline = monthlyTotal * months;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(monthlyTotal) || !Number.isSafeInteger(baseline)
    || total <= 0 || monthlyTotal <= 0 || baseline <= total) return null;
  const percent = Math.round((1 - total / baseline) * 100);
  if (percent <= 0) return null;
  const formatter = new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US", { style: "currency", currency: price.currency });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return { percent, formattedTotal: formatter.format(baseline / 10 ** fractionDigits) };
}

/** Only compare against a planned price in the same currency and exact catalog amount. */
export function comparisonCurrency(plan: PurchasePlan, price: LocalizedPrice): "USD" | "KRW" | null {
  const expected = price.currency === "USD" ? Math.round(PLANS[plan].usd * 100) : price.currency === "KRW" ? PLANS[plan].krw : null;
  return expected !== null && String(expected) === price.total ? price.currency as "USD" | "KRW" : null;
}
