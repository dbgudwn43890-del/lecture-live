import test from "node:test";
import assert from "node:assert/strict";
import { checkoutReturnPath } from "./payment-return.ts";

test("checkout returns to the localized classroom, not a confirmation page", () => {
  assert.equal(checkoutReturnPath("ko", "txn_abc123"), "/classroom?lang=ko&billing_tx=txn_abc123");
  assert.equal(checkoutReturnPath("en", "txn_abc123"), "/en/classroom?lang=en&billing_tx=txn_abc123");
});
test("payment return never accepts a destination or arbitrary query from checkout data", () => {
  for (const id of [null, undefined, "https://evil.test", "txn_a&payment=success", "txn_" + "a".repeat(100)]) {
    assert.equal(checkoutReturnPath("en", id), "/en/classroom?lang=en");
  }
});
