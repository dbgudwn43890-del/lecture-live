import assert from "node:assert/strict";
import test from "node:test";
import {
  EMAIL_CODE_LENGTH, MIN_PASSWORD_LENGTH, emailAuthErrorMessage, requestPasswordReset,
  resendSignupCode, signInWithEmail, signupWithEmail, updatePassword,
  validateEmail, validateEmailCode, validatePassword, verifyRecoveryCode, verifySignupCode,
  type EmailAuthClient,
} from "./email-auth.ts";

const verifiedUser = { id: "user-1", email: "student@example.com", email_confirmed_at: "2026-09-07T12:00:00Z" };
const verifiedResponse = { data: { user: verifiedUser, session: { user: verifiedUser } }, error: null };
const emptyResponse = { data: { user: null, session: null }, error: null };
const credentials = { email: " Student@Example.com ", password: "a long password", redirectTo: "https://www.lecue.app/auth/callback?next=%2Fclassroom" };

function makeClient(overrides: Partial<EmailAuthClient["auth"]> = {}) {
  const calls: [string, unknown][] = [];
  const auth: EmailAuthClient["auth"] = {
    async signUp(input) { calls.push(["signup", input]); return emptyResponse; },
    async signInWithPassword(input) { calls.push(["login", input]); return verifiedResponse; },
    async verifyOtp(input) { calls.push(["verify", input]); return verifiedResponse; },
    async resend(input) { calls.push(["resend", input]); return { error: null }; },
    async resetPasswordForEmail(email, options) { calls.push(["recovery", { email, options }]); return { error: null }; },
    async getUser() { calls.push(["get-user", null]); return { data: { user: verifiedUser }, error: null }; },
    async updateUser(input) { calls.push(["update", input]); return { data: { user: verifiedUser }, error: null }; },
    async signOut(input) { calls.push(["signout", input]); return { error: null }; },
    ...overrides,
  };
  return { client: { auth }, calls };
}

test("email and code validation reject incomplete inputs, without mutating password whitespace", () => {
  assert.equal(EMAIL_CODE_LENGTH, 8);
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  for (const value of ["", "a", "a@", "a@b", "a b@c.com", "a@@b.com"]) assert.equal(validateEmail(value), "invalid_email");
  assert.equal(validateEmail(" Student+Class@Example.com "), null);
  assert.equal(validatePassword("1234567"), "weak_password");
  assert.equal(validatePassword(" 123456 "), null);
  for (const value of ["", "123456", "123456789", "1234abcd", "1234 5678"]) assert.equal(validateEmailCode(value), "invalid_code");
  assert.equal(validateEmailCode(" 01234567 "), null);
});

test("signup waits for verification and passes the original password directly to Supabase", async () => {
  const { client, calls } = makeClient();
  assert.deepEqual(await signupWithEmail(client, credentials), { ok: true, status: "sent" });
  assert.deepEqual(calls, [["signup", {
    email: "student@example.com", password: credentials.password,
    options: { emailRedirectTo: credentials.redirectTo },
  }]]);
});

test("invalid signup input and insecure redirects never contact the provider", async () => {
  const { client, calls } = makeClient();
  assert.deepEqual(await signupWithEmail(client, { ...credentials, password: "short" }), { ok: false, code: "weak_password" });
  for (const redirectTo of ["javascript:alert(1)", "http://lecue.app/auth/callback", "https://u:p@lecue.app/auth/callback", "https://lecue.app/classroom"]) {
    assert.deepEqual(await signupWithEmail(client, { ...credentials, redirectTo }), { ok: false, code: "verification_unavailable" });
  }
  assert.equal(calls.length, 0);
});

test("signup discards an unexpected session even if the provider marks it confirmed", async () => {
  const { client, calls } = makeClient({ async signUp() { return verifiedResponse; } });
  assert.deepEqual(await signupWithEmail(client, credentials), { ok: false, code: "verification_unavailable" });
  assert.deepEqual(calls, [["signout", { scope: "local" }]]);
});

test("signup remains blocked when discarding an unexpected session encounters a network failure", async () => {
  const { client } = makeClient({
    async signUp() { return verifiedResponse; },
    async signOut() { throw new TypeError("request failed"); },
  });
  assert.deepEqual(await signupWithEmail(client, credentials), { ok: false, code: "verification_unavailable" });
});

test("existing-account signup responses and signup resend cannot reveal account existence", async () => {
  for (const code of ["user_already_exists", "email_exists", "user_not_found"]) {
    const { client } = makeClient({
      async signUp() { return { ...emptyResponse, error: { code } }; },
      async resend() { return { error: { code } }; },
    });
    assert.deepEqual(await signupWithEmail(client, credentials), { ok: true, status: "sent" });
    assert.deepEqual(await resendSignupCode(client, credentials), { ok: true, status: "sent" });
  }
  const { client } = makeClient({ async signUp() { return { data: { user: verifiedUser, session: null }, error: null }; } });
  assert.deepEqual(await signupWithEmail(client, credentials), { ok: true, status: "sent" });
});

test("ordinary login accepts only a session for the verified requested email", async () => {
  const { client, calls } = makeClient();
  assert.deepEqual(await signInWithEmail(client, credentials), { ok: true, status: "authenticated" });
  assert.deepEqual(calls, [["login", { email: "student@example.com", password: credentials.password }]]);
  for (const user of [
    { ...verifiedUser, email_confirmed_at: undefined },
    { ...verifiedUser, email: "someone-else@example.com" },
  ]) {
    const result = makeClient({ async signInWithPassword() { return { data: { user, session: { user } }, error: null }; } });
    assert.deepEqual(await signInWithEmail(result.client, credentials), { ok: false, code: "confirmation_required" });
    assert.deepEqual(result.calls, [["signout", { scope: "local" }]]);
  }
});

test("ordinary login does not create new password requirements for an existing account", async () => {
  const { client, calls } = makeClient();
  await signInWithEmail(client, { ...credentials, password: "older" });
  assert.equal(calls.length, 1);
  assert.deepEqual(await signInWithEmail(client, { ...credentials, password: "" }), { ok: false, code: "password_required" });
  assert.equal(calls.length, 1);
});

test("login surfaces unconfirmed email separately while keeping bad account/password errors generic", async () => {
  for (const [code, expected] of [["email_not_confirmed", "confirmation_required"], ["invalid_credentials", "invalid_credentials"], ["user_not_found", "invalid_credentials"]]) {
    const { client } = makeClient({ async signInWithPassword() { return { ...emptyResponse, error: { code } }; } });
    assert.deepEqual(await signInWithEmail(client, credentials), { ok: false, code: expected });
  }
});

test("signup and recovery codes use distinct provider verification types", async () => {
  const { client, calls } = makeClient();
  const input = { email: credentials.email, code: " 01234567 " };
  assert.deepEqual(await verifySignupCode(client, input), { ok: true, status: "authenticated" });
  assert.deepEqual(await verifyRecoveryCode(client, input), { ok: true, status: "recovery_verified" });
  assert.deepEqual(calls, [
    ["verify", { email: "student@example.com", token: "01234567", type: "email" }],
    ["verify", { email: "student@example.com", token: "01234567", type: "recovery" }],
  ]);
});

test("verification cannot succeed without the matching confirmed session", async () => {
  const unconfirmed = { ...verifiedUser, email_confirmed_at: undefined };
  for (const data of [
    { user: verifiedUser, session: null },
    { user: unconfirmed, session: { user: unconfirmed } },
    { user: verifiedUser, session: { user: { ...verifiedUser, id: "different-id" } } },
  ]) {
    const { client } = makeClient({ async verifyOtp() { return { data, error: null }; } });
    assert.deepEqual(await verifySignupCode(client, { email: credentials.email, code: "01234567" }), { ok: false, code: "verification_unavailable" });
  }
});

test("verification distinguishes expired codes and rate limits without exposing provider error text", async () => {
  for (const [error, expected] of [
    [{ code: "otp_expired" }, "expired_code"],
    [{ code: "bad_code" }, "invalid_code"],
    [{ status: 429 }, "rate_limited"],
    [{ code: "over_request_rate_limit" }, "rate_limited"],
  ] as const) {
    const { client } = makeClient({ async verifyOtp() { return { ...emptyResponse, error }; } });
    assert.deepEqual(await verifyRecoveryCode(client, { email: credentials.email, code: "01234567" }), { ok: false, code: expected });
  }
});

test("resend uses signup confirmation, never passwordless login or a new password", async () => {
  const { client, calls } = makeClient();
  assert.deepEqual(await resendSignupCode(client, credentials), { ok: true, status: "sent" });
  assert.deepEqual(calls, [["resend", {
    type: "signup", email: "student@example.com", options: { emailRedirectTo: credentials.redirectTo },
  }]]);
});

test("recovery emails are account-neutral and never create an account", async () => {
  const { client, calls } = makeClient();
  assert.deepEqual(await requestPasswordReset(client, credentials), { ok: true, status: "sent" });
  assert.deepEqual(calls, [["recovery", { email: "student@example.com", options: { redirectTo: credentials.redirectTo } }]]);
  const missing = makeClient({ async resetPasswordForEmail() { return { error: { code: "user_not_found" } }; } });
  assert.deepEqual(await requestPasswordReset(missing.client, credentials), { ok: true, status: "sent" });
});

test("network and email-service errors give actionable generic messages", async () => {
  const disconnected = makeClient({ async resetPasswordForEmail() { throw new TypeError("could contain private provider response"); } });
  assert.deepEqual(await requestPasswordReset(disconnected.client, credentials), { ok: false, code: "network" });
  const serviceFailure = makeClient({ async signUp() { return { ...emptyResponse, error: { code: "unexpected_failure", status: 500 } }; } });
  assert.deepEqual(await signupWithEmail(serviceFailure.client, credentials), { ok: false, code: "send_failed" });
  assert.equal(emailAuthErrorMessage("invalid_credentials", true), "Check your email and password.");
  assert.equal(emailAuthErrorMessage("confirmation_required", false), "이메일 인증을 먼저 완료해 주세요.");
});

test("Supabase SMTP failures wrapped as retryable fetch errors report email delivery failure", async () => {
  const smtpError = { name: "AuthRetryableFetchError", status: 500 };
  const { client } = makeClient({
    async signUp() { return { ...emptyResponse, error: smtpError }; },
    async resetPasswordForEmail() { return { error: smtpError }; },
    async resend() { throw smtpError; },
  });
  for (const action of [signupWithEmail, requestPasswordReset, resendSignupCode]) {
    assert.deepEqual(await action(client, credentials), { ok: false, code: "send_failed" });
  }
});

test("changing a password rechecks the verified current account and keeps the recovered session", async () => {
  const { client, calls } = makeClient();
  assert.deepEqual(await updatePassword(client, { password: "new long password" }), { ok: true, status: "password_updated" });
  assert.deepEqual(calls, [["get-user", null], ["update", { password: "new long password" }]]);
});

test("changing a password stops before update when the current account is missing or unconfirmed", async () => {
  for (const user of [null, { ...verifiedUser, email_confirmed_at: undefined }]) {
    const { client, calls } = makeClient({ async getUser() { return { data: { user }, error: null }; } });
    assert.deepEqual(await updatePassword(client, { password: "new long password" }), { ok: false, code: "session_expired" });
    assert.deepEqual(calls, [["signout", { scope: "local" }]]);
  }
});

test("changing a password rejects a changed account or same-password provider response", async () => {
  const changed = makeClient({ async updateUser() { return { data: { user: { ...verifiedUser, id: "another-account" } }, error: null }; } });
  assert.deepEqual(await updatePassword(changed.client, { password: "new long password" }), { ok: false, code: "session_expired" });
  const same = makeClient({ async updateUser() { return { data: { user: null }, error: { code: "same_password" } }; } });
  assert.deepEqual(await updatePassword(same.client, { password: "new long password" }), { ok: false, code: "same_password" });
});
