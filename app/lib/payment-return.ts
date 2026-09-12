export const PENDING_PAYMENT_KEY = "lecue-pending-payment";

export function isPaymentTransaction(value: unknown): value is string {
  return typeof value === "string" && /^txn_[a-z0-9]+$/.test(value) && value.length <= 64;
}

/** Navigation is not proof of payment. The classroom verifies this ID with the server. */
export function checkoutReturnPath(locale: "ko" | "en", transactionId?: unknown) {
  const path = locale === "en" ? "/en/classroom" : "/classroom";
  const query = new URLSearchParams({ lang: locale });
  if (isPaymentTransaction(transactionId)) query.set("billing_tx", transactionId);
  return `${path}?${query}`;
}
