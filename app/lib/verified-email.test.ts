import assert from "node:assert/strict";
import test from "node:test";
import { hasVerifiedEmail } from "./verified-email.ts";

test("confirmed Google and password users both qualify without metadata checks", () => {
  for (const provider of ["google", "email"]) {
    assert.equal(hasVerifiedEmail({
      email: "learner@example.test",
      email_confirmed_at: "2026-09-07T00:00:00Z",
      app_metadata: { provider },
      user_metadata: { email_verified: false },
    }), true);
  }
});

test("pending, missing-email, anonymous and metadata-only accounts are denied", () => {
  for (const user of [
    null,
    undefined,
    { email: "learner@example.test" },
    { email: "learner@example.test", email_confirmed_at: "" },
    { email: "", email_confirmed_at: "2026-09-07T00:00:00Z" },
    { email: "learner@example.test", user_metadata: { email_verified: true } },
    { email: "learner@example.test", is_anonymous: true, email_confirmed_at: "2026-09-07T00:00:00Z" },
  ]) assert.equal(hasVerifiedEmail(user), false);
});
