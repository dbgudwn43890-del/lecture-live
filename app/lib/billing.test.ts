import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { addUtcMonths, isBillingPlan, isUuid, verifyPaddleSignature } from "./billing.ts";

test("verifies an untampered Paddle signature", () => {
  const body = '{"event_id":"evt_test"}';
  const secret = "pdl_ntfset_test";
  const timestamp = 1_800_000_000;
  const signature = createHmac("sha256", secret).update(`${timestamp}:${body}`).digest("hex");
  assert.equal(verifyPaddleSignature(body, `ts=${timestamp};h1=${signature}`, secret, timestamp), true);
  assert.equal(verifyPaddleSignature(`${body} `, `ts=${timestamp};h1=${signature}`, secret, timestamp), false);
  assert.equal(verifyPaddleSignature(body, `ts=${timestamp};h1=${signature}`, secret, timestamp + 31), false);
});

test("keeps calendar-month expiry at the end of shorter months", () => {
  assert.equal(addUtcMonths("2026-08-31T12:00:00.000Z", 6), "2027-02-28T12:00:00.000Z");
});

test("accepts canonical UUIDs only", () => {
  assert.equal(isUuid("2f4fd830-c135-4ab7-bd81-6d060b5625b9"), true);
  assert.equal(isUuid("2f4fd830-c135-4ab7-not-a-uuid"), false);
});

test("accepts each sellable billing plan", () => {
  assert.equal(isBillingPlan("monthly"), true);
  assert.equal(isBillingPlan("term"), true);
  assert.equal(isBillingPlan("semester"), true);
  assert.equal(isBillingPlan("trial"), false);
});
