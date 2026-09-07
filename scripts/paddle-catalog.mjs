// Paddle catalog from app/lib/plans.ts — the single source of truth the
// checkout route already enforces (CATALOG_MISMATCH). Idempotent: a price is
// reused when its custom_data.lecue_key matches the plan's current
// price/cycle; anything else gets a fresh price so earlier purchases keep
// their entitlements. Also ensures payment, subscription and refund webhooks.
//
//   node --experimental-strip-types scripts/paddle-catalog.mjs --env sandbox|live \
//     [--webhook https://www.lecue.app/api/billing/webhook]
//
// Reads PADDLE_CATALOG_API_KEY (falls back to PADDLE_API_KEY). Prints the env
// lines to paste into Vercel. Secrets never hit git.

import { PLANS, PURCHASE_PLANS } from "../app/lib/plans.ts";

const args = Object.fromEntries(process.argv.slice(2).map((arg, i, all) => arg.startsWith("--") ? [arg.slice(2), all[i + 1]] : []).filter(Boolean));
const environment = args.env;
if (environment !== "sandbox" && environment !== "live") { console.error("--env sandbox|live required"); process.exit(1); }
const apiKey = process.env.PADDLE_CATALOG_API_KEY || process.env.PADDLE_API_KEY;
if (!apiKey) { console.error("PADDLE_CATALOG_API_KEY (or PADDLE_API_KEY) required"); process.exit(1); }
if (environment === "live" && !apiKey.startsWith("pdl_live_")) { console.error("live needs a pdl_live_ key"); process.exit(1); }
if (environment === "sandbox" && !apiKey.startsWith("pdl_sdbx_")) { console.error("sandbox needs a pdl_sdbx_ key"); process.exit(1); }
const base = environment === "live" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
const webhookUrl = args.webhook ?? "https://www.lecue.app/api/billing/webhook";

async function paddle(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${response.status} ${JSON.stringify(body.error ?? body)}`);
  return body.data;
}

const PRODUCT_NAME = "Lecue";
const products = await paddle("/products?status=active&per_page=200");
let product = products.find((p) => p.name === PRODUCT_NAME);
if (!product) {
  product = await paddle("/products", { method: "POST", body: JSON.stringify({
    name: PRODUCT_NAME,
    description: "Live lecture transcription and a study assistant that answers from the lecture so far.",
    tax_category: "standard",
    custom_data: { lecue: true },
  }) });
  console.error(`created product ${product.id}`);
} else {
  console.error(`reusing product ${product.id}`);
}

const prices = await paddle(`/prices?product_id=${product.id}&status=active&per_page=200`);
const envLines = [];
for (const plan of PURCHASE_PLANS) {
  const offer = PLANS[plan];
  const usd = String(Math.round(offer.usd * 100));
  const krw = String(offer.krw);
  const key = `${plan}:${usd}:${krw}:${offer.recurring ? "month" : "once"}`;
  let price = prices.find((p) => p.custom_data?.lecue_key === key);
  if (!price) {
    price = await paddle("/prices", { method: "POST", body: JSON.stringify({
      product_id: product.id,
      name: offer.name,
      description: offer.recurring
        ? `Lecue ${offer.name} — ${offer.credits.toLocaleString("en-US")} credits every month`
        : `Lecue ${offer.name} — ${offer.credits.toLocaleString("en-US")} credits, valid ${offer.months} months`,
      unit_price: { amount: usd, currency_code: "USD" },
      unit_price_overrides: [{ country_codes: ["KR"], unit_price: { amount: krw, currency_code: "KRW" } }],
      billing_cycle: offer.recurring ? { interval: "month", frequency: 1 } : null,
      trial_period: null,
      tax_mode: "internal",
      quantity: { minimum: 1, maximum: 1 },
      custom_data: { lecue_key: key, plan, credits: offer.credits, months: offer.months },
    }) });
    console.error(`created ${plan} ${price.id}`);
  } else {
    console.error(`reusing ${plan} ${price.id}`);
  }
  envLines.push(`PADDLE_${plan.toUpperCase()}_V2_PRICE_ID=${price.id}`);
}

const settings = await paddle("/notification-settings");
const requiredEvents = ["transaction.completed", "subscription.created", "subscription.updated",
  "subscription.activated", "subscription.canceled", "subscription.paused", "subscription.resumed",
  "subscription.past_due", "subscription.trialing", "adjustment.created", "adjustment.updated"];
let setting = settings.find((s) => s.destination === webhookUrl);
if (!setting) {
  setting = await paddle("/notification-settings", { method: "POST", body: JSON.stringify({
    description: "Lecue billing webhook",
    destination: webhookUrl,
    type: "url",
    subscribed_events: requiredEvents,
    api_version: 1,
    traffic_source: environment === "live" ? "platform" : "all",
  }) });
  console.error(`created webhook ${setting.id}`);
} else {
  const existingEvents = setting.subscribed_events.map((event) => typeof event === "string" ? event : event.name);
  if (!setting.active || requiredEvents.some((event) => !existingEvents.includes(event))) {
    setting = await paddle(`/notification-settings/${setting.id}`, { method: "PATCH", body: JSON.stringify({
      active: true,
      subscribed_events: [...new Set([...existingEvents, ...requiredEvents])],
    }) });
  }
  console.error(`reusing webhook ${setting.id} (${setting.subscribed_events.length} events)`);
}

console.log([
  `BILLING_ENABLED=true`,
  `PADDLE_ENVIRONMENT=${environment === "live" ? "production" : "sandbox"}`,
  `NEXT_PUBLIC_PADDLE_ENVIRONMENT=${environment === "live" ? "production" : "sandbox"}`,
  `PADDLE_WEBHOOK_SECRET=${setting.endpoint_secret_key}`,
  ...envLines,
  `# NEXT_PUBLIC_PADDLE_CLIENT_TOKEN and PADDLE_API_KEY: dashboard-only, set by hand`,
].join("\n"));
