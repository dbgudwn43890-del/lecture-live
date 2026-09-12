import assert from "node:assert/strict";
import test from "node:test";
import { canUseLiveAssist } from "./live-assist-access.ts";

const verified = { email: "dbgudwn43890@gmail.com", email_confirmed_at: "2026-09-09T00:00:00Z" };

test("live assistance allows only the exact verified admin email", () => {
  assert.equal(canUseLiveAssist(verified), true);
  for (const user of [
    null, undefined, {}, { email: verified.email }, { ...verified, email_confirmed_at: null },
    { ...verified, email_confirmed_at: " " }, { ...verified, email_confirmed_at: "invalid" },
    { ...verified, email: "someone@example.test" }, { ...verified, email: "DBGUDWN43890@gmail.com" },
    { ...verified, email: ` ${verified.email}` }, { ...verified, is_anonymous: true },
    { email: verified.email, user_metadata: { email_verified: true } },
    { email: "someone@example.test", email_confirmed_at: verified.email_confirmed_at, user_metadata: { email: verified.email } },
  ]) assert.equal(canUseLiveAssist(user), false);
});
