import test from "node:test";
import assert from "node:assert/strict";
import { billingMode } from "./billing-config.ts";

test("billing rejects mixed credentials and sandbox checkout on production", () => {
  const keys = ["BILLING_ENABLED", "PADDLE_ENVIRONMENT", "NEXT_PUBLIC_PADDLE_ENVIRONMENT", "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", "PADDLE_API_KEY", "PADDLE_WEBHOOK_SECRET", "PADDLE_MONTHLY_V3_PRICE_ID", "VERCEL_ENV"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { BILLING_ENABLED: "true", PADDLE_ENVIRONMENT: "production", NEXT_PUBLIC_PADDLE_ENVIRONMENT: "production", NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "live_test", PADDLE_API_KEY: "pdl_live_test", PADDLE_WEBHOOK_SECRET: "test", PADDLE_MONTHLY_V3_PRICE_ID: "pri_test", VERCEL_ENV: "production" });
    assert.equal(billingMode(), "live");
    process.env.PADDLE_API_KEY = "pdl_sdbx_test";
    assert.equal(billingMode(), "disabled");
    Object.assign(process.env, { PADDLE_ENVIRONMENT: "sandbox", NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox", NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_test" });
    assert.equal(billingMode(), "disabled");
    process.env.VERCEL_ENV = "development";
    assert.equal(billingMode(), "sandbox");
    process.env.PADDLE_API_KEY = "pdl_live_test";
    assert.equal(billingMode(), "disabled");
  } finally {
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  }
});
