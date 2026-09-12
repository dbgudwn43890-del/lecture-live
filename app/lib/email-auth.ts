/** Browser auth actions. Supabase remains responsible for email verification and rate limits. */
export const MIN_PASSWORD_LENGTH = 8;
export const EMAIL_CODE_LENGTH = 8;

export type EmailAuthErrorCode =
  | "invalid_email"
  | "password_required"
  | "weak_password"
  | "invalid_code"
  | "expired_code"
  | "invalid_credentials"
  | "confirmation_required"
  | "rate_limited"
  | "network"
  | "verification_unavailable"
  | "session_expired"
  | "same_password"
  | "send_failed"
  | "failed";

type AuthError = { code?: string; status?: number; name?: string };
type AuthUser = { id: string; email?: string; email_confirmed_at?: string };
type AuthResponse = {
  data: { user: AuthUser | null; session: { user: AuthUser } | null };
  error: AuthError | null;
};
type ErrorResponse = { error: AuthError | null };

/** A real Supabase client satisfies this interface; tests can inject only these methods. */
export type EmailAuthClient = {
  auth: {
    signUp(input: { email: string; password: string; options: { emailRedirectTo: string } }): Promise<AuthResponse>;
    signInWithPassword(input: { email: string; password: string }): Promise<AuthResponse>;
    verifyOtp(input: { email: string; token: string; type: "email" | "recovery" }): Promise<AuthResponse>;
    resend(input: { type: "signup"; email: string; options: { emailRedirectTo: string } }): Promise<ErrorResponse>;
    resetPasswordForEmail(email: string, options: { redirectTo: string }): Promise<ErrorResponse>;
    getUser(): Promise<{ data: { user: AuthUser | null }; error: AuthError | null }>;
    updateUser(input: { password: string }): Promise<{ data: { user: AuthUser | null }; error: AuthError | null }>;
    signOut(input: { scope: "local" }): Promise<ErrorResponse>;
  };
};

export type EmailAuthResult =
  | { ok: true; status: "sent" | "authenticated" | "recovery_verified" | "password_updated" }
  | { ok: false; code: EmailAuthErrorCode };

type Action = "signup" | "resend" | "login" | "verify" | "recovery" | "update";
const failure = (code: EmailAuthErrorCode): EmailAuthResult => ({ ok: false, code });
const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function validateEmail(email: string): EmailAuthErrorCode | null {
  const value = normalizeEmail(email);
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : "invalid_email";
}

export function validatePassword(password: string): EmailAuthErrorCode | null {
  return password.length >= MIN_PASSWORD_LENGTH ? null : "weak_password";
}

export function validateEmailCode(code: string): EmailAuthErrorCode | null {
  return new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`).test(code.trim()) ? null : "invalid_code";
}

function errorCode(error: unknown, action: Action): EmailAuthErrorCode {
  const detail = error && typeof error === "object" ? error as AuthError : {};
  if (detail.status === 429 || detail.code?.startsWith("over_")) return "rate_limited";
  if (detail.status && detail.status >= 500 && (action === "signup" || action === "recovery" || action === "resend")) return "send_failed";
  if (detail.name === "AuthRetryableFetchError" || detail.name === "TypeError") return "network";
  if (detail.code === "email_not_confirmed") return "confirmation_required";
  if (detail.code === "weak_password") return "weak_password";
  if (detail.code === "same_password") return "same_password";
  if (detail.code === "otp_expired") return "expired_code";
  if (detail.code === "session_not_found" || detail.code === "refresh_token_not_found") return "session_expired";
  if (action === "login") return "invalid_credentials";
  if (action === "verify") return "invalid_code";
  if (action === "signup" || action === "recovery" || action === "resend") return "send_failed";
  return "failed";
}

async function run(action: Action, operation: () => Promise<EmailAuthResult>): Promise<EmailAuthResult> {
  try {
    return await operation();
  } catch (error) {
    return failure(errorCode(error, action));
  }
}

function isVerified(user: AuthUser | null, email?: string): boolean {
  return Boolean(user?.email_confirmed_at && user.email && (!email || normalizeEmail(user.email) === email));
}

async function discardSession(client: EmailAuthClient) {
  // Only this device is affected; a failed verification must not revoke other signed-in devices.
  try { await client.auth.signOut({ scope: "local" }); } catch { /* The caller still fails closed. */ }
}

function obscuredAccount(error: AuthError | null) {
  return error?.code === "user_already_exists" || error?.code === "email_exists" || error?.code === "user_not_found";
}

function isValidRedirect(redirectTo: string) {
  try {
    const url = new URL(redirectTo);
    return (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      && !url.username && !url.password && url.pathname === "/auth/callback";
  } catch { return false; }
}

export async function signupWithEmail(client: EmailAuthClient, input: { email: string; password: string; redirectTo: string }): Promise<EmailAuthResult> {
  const validation = validateEmail(input.email) ?? validatePassword(input.password);
  if (validation) return failure(validation);
  if (!isValidRedirect(input.redirectTo)) return failure("verification_unavailable");
  return run("signup", async () => {
    const { data, error } = await client.auth.signUp({
      email: normalizeEmail(input.email), password: input.password,
      options: { emailRedirectTo: input.redirectTo },
    });
    if (data.session) {
      // A signup session means confirmation was disabled. Never advance to the classroom.
      await discardSession(client);
      return failure("verification_unavailable");
    }
    if (error && !obscuredAccount(error)) return failure(errorCode(error, "signup"));
    // Confirmed addresses may return an obfuscated user. Keep the same email-check screen.
    return { ok: true, status: "sent" };
  });
}

export async function signInWithEmail(client: EmailAuthClient, input: { email: string; password: string }): Promise<EmailAuthResult> {
  const validation = validateEmail(input.email);
  if (validation) return failure(validation);
  if (!input.password) return failure("password_required");
  return run("login", async () => {
    const email = normalizeEmail(input.email);
    const { data, error } = await client.auth.signInWithPassword({ email, password: input.password });
    if (error) return failure(errorCode(error, "login"));
    if (!data.session || !isVerified(data.user, email) || data.session.user.id !== data.user?.id) {
      if (data.session) await discardSession(client);
      return failure("confirmation_required");
    }
    return { ok: true, status: "authenticated" };
  });
}

async function verifyCode(client: EmailAuthClient, input: { email: string; code: string }, type: "email" | "recovery"): Promise<EmailAuthResult> {
  const validation = validateEmail(input.email) ?? validateEmailCode(input.code);
  if (validation) return failure(validation);
  return run("verify", async () => {
    const email = normalizeEmail(input.email);
    const { data, error } = await client.auth.verifyOtp({ email, token: input.code.trim(), type });
    if (error) return failure(errorCode(error, "verify"));
    if (!data.session || !isVerified(data.user, email) || data.session.user.id !== data.user?.id) {
      if (data.session) await discardSession(client);
      return failure("verification_unavailable");
    }
    return { ok: true, status: type === "email" ? "authenticated" : "recovery_verified" };
  });
}

export function verifySignupCode(client: EmailAuthClient, input: { email: string; code: string }) {
  return verifyCode(client, input, "email");
}

export function verifyRecoveryCode(client: EmailAuthClient, input: { email: string; code: string }) {
  return verifyCode(client, input, "recovery");
}

export async function resendSignupCode(client: EmailAuthClient, input: { email: string; redirectTo: string }): Promise<EmailAuthResult> {
  const validation = validateEmail(input.email);
  if (validation) return failure(validation);
  if (!isValidRedirect(input.redirectTo)) return failure("verification_unavailable");
  return run("resend", async () => {
    const { error } = await client.auth.resend({
      type: "signup", email: normalizeEmail(input.email), options: { emailRedirectTo: input.redirectTo },
    });
    if (error && !obscuredAccount(error)) return failure(errorCode(error, "resend"));
    return { ok: true, status: "sent" };
  });
}

export async function requestPasswordReset(client: EmailAuthClient, input: { email: string; redirectTo: string }): Promise<EmailAuthResult> {
  const validation = validateEmail(input.email);
  if (validation) return failure(validation);
  if (!isValidRedirect(input.redirectTo)) return failure("verification_unavailable");
  return run("recovery", async () => {
    const { error } = await client.auth.resetPasswordForEmail(normalizeEmail(input.email), { redirectTo: input.redirectTo });
    if (error && !obscuredAccount(error)) return failure(errorCode(error, "recovery"));
    return { ok: true, status: "sent" };
  });
}

export async function updatePassword(client: EmailAuthClient, input: { password: string }): Promise<EmailAuthResult> {
  const validation = validatePassword(input.password);
  if (validation) return failure(validation);
  return run("update", async () => {
    const current = await client.auth.getUser();
    if (current.error) return failure(errorCode(current.error, "update"));
    if (!isVerified(current.data.user)) {
      await discardSession(client);
      return failure("session_expired");
    }
    const { data, error } = await client.auth.updateUser({ password: input.password });
    if (error) return failure(errorCode(error, "update"));
    if (!isVerified(data.user) || data.user?.id !== current.data.user?.id) {
      await discardSession(client);
      return failure("session_expired");
    }
    return { ok: true, status: "password_updated" };
  });
}

const errors: Record<EmailAuthErrorCode, [string, string]> = {
  invalid_email: ["이메일 주소를 확인해 주세요.", "Enter a valid email address."],
  password_required: ["비밀번호를 입력해 주세요.", "Enter your password."],
  weak_password: ["비밀번호는 8자 이상으로 설정해 주세요.", "Use a password with at least 8 characters."],
  invalid_code: ["이메일로 받은 8자리 인증번호를 확인해 주세요.", "Check the 8-digit code in your email."],
  expired_code: ["인증번호가 만료되었거나 유효하지 않습니다. 새 인증번호를 받아 주세요.", "This code is expired or invalid. Request a new code."],
  invalid_credentials: ["이메일 또는 비밀번호를 확인해 주세요.", "Check your email and password."],
  confirmation_required: ["이메일 인증을 먼저 완료해 주세요.", "Verify your email before signing in."],
  rate_limited: ["요청이 많습니다. 잠시 후 다시 시도해 주세요.", "Too many attempts. Please try again shortly."],
  network: ["연결이 원활하지 않습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.", "Check your internet connection and try again."],
  verification_unavailable: ["이메일 인증을 완료할 수 없습니다. 잠시 후 다시 시도해 주세요.", "Email verification is unavailable. Please try again shortly."],
  session_expired: ["인증 시간이 만료되었습니다. 이메일 인증을 다시 진행해 주세요.", "Your verification session expired. Verify your email again."],
  same_password: ["기존 비밀번호와 다른 비밀번호를 입력해 주세요.", "Choose a password different from your current password."],
  send_failed: ["인증 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.", "We couldn’t send the verification email. Please try again shortly."],
  failed: ["처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", "Something went wrong. Please try again shortly."],
};

export function emailAuthErrorMessage(code: EmailAuthErrorCode, isEnglish: boolean): string {
  return errors[code][isEnglish ? 1 : 0];
}
