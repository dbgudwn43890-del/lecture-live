"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Eye, EyeOff, Mail } from "lucide-react";
import { getSafeAuthNext } from "../lib/auth-redirect";
import {
  EMAIL_CODE_LENGTH, MIN_PASSWORD_LENGTH, emailAuthErrorMessage,
  requestPasswordReset, resendSignupCode, signInWithEmail, signupWithEmail,
  updatePassword, verifyRecoveryCode, verifySignupCode,
  type EmailAuthErrorCode, type EmailAuthResult,
} from "../lib/email-auth";
import { languageSwitchUrl } from "../lib/site-locale";
import SiteLanguageMenu from "../site-language-menu";
import { createClient } from "../lib/supabase/client";
import { trackAnalyticsEvent } from "../lib/analytics";
import "./login.css";

type Mode = "login" | "signup" | "verify-signup" | "reset" | "verify-recovery" | "new-password" | "complete";
type MailStep = { kind: "signup" | "recovery"; email: string; sentAt: number };
type RecoveryPasswordStep = { kind: "recovery-password"; email: string; userId: string; verifiedAt: number };
type Pending = "submit" | "resend" | "google" | null;
const MAIL_STEP_KEY = "lecue.email-verification.v1";

function storageKey(next: string) {
  const url = new URL(next, "https://lecue.app");
  url.searchParams.delete("lang");
  return `${MAIL_STEP_KEY}:${url.pathname.replace(/^\/en(?=\/)/, "")}${url.search}`;
}

function GoogleMark() {
  return (
    <svg className="google-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.05H12v3.87h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.35Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.6-4.12H3.05v2.59A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 13.91A6 6 0 0 1 6.08 12c0-.66.11-1.3.32-1.91V7.5H3.05A10 10 0 0 0 2 12c0 1.61.39 3.14 1.05 4.5l3.35-2.59Z" />
      <path fill="#EA4335" d="M12 5.97c1.47 0 2.79.5 3.82 1.5l2.87-2.87A9.63 9.63 0 0 0 12 2a10 10 0 0 0-8.95 5.5l3.35 2.59c.8-2.36 3-4.12 5.6-4.12Z" />
    </svg>
  );
}

export default function LoginClient({ locale = "ko", region }: { locale?: "ko" | "en"; region: "kr" | "global" }) {
  const isEnglish = locale === "en";
  const basePath = isEnglish ? "/en" : "";
  const classroomPath = `${basePath}/classroom`;
  const [nextPath, setNextPath] = useState(classroomPath);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [mailStep, setMailStep] = useState<MailStep | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<EmailAuthErrorCode | null>(null);
  const [notice, setNotice] = useState("");
  const pendingRef = useRef<Pending>(null);
  const alive = useRef(false);
  const requestId = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousMode = useRef(mode);
  const isEntry = mode === "login" || mode === "signup";
  const isVerification = mode === "verify-signup" || mode === "verify-recovery";
  const busy = Boolean(pending) || !ready;

  useEffect(() => {
    alive.current = true;
    requestId.current += 1;
    const params = new URLSearchParams(window.location.search);
    const next = getSafeAuthNext(params.get("next"), classroomPath);
    setNextPath(next);
    async function restore() {
      const restoreId = requestId.current;
      setReady(false);
      let saved: MailStep | RecoveryPasswordStep | null = null;
      try { saved = JSON.parse(sessionStorage.getItem(storageKey(next)) || "null"); } catch { /* Optional persistence. */ }
      if (params.get("mode") === "recovery") {
        setMode("reset");
        setMailStep(null);
        try { sessionStorage.removeItem(storageKey(next)); } catch { /* Optional persistence. */ }
        setNotice(isEnglish ? "Request a new code to reset your password." : "비밀번호를 바꾸려면 새 인증번호를 받아 주세요.");
        // Consume the callback fallback once, so a later refresh can resume the verified password step.
        params.delete("mode");
        params.delete("error");
        const search = params.toString();
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
      } else if (saved && typeof saved.email === "string" && saved.email.length <= 320) {
        if (saved.kind === "recovery-password" && typeof saved.userId === "string"
          && typeof saved.verifiedAt === "number" && saved.verifiedAt <= Date.now()
          && Date.now() - saved.verifiedAt < 3_600_000) {
          // A stored step is only a UI hint. Revalidate identity with Auth before showing the password form.
          let verified = false;
          try {
            const { data, error: authError } = await createClient().auth.getUser();
            verified = !authError && data.user?.id === saved.userId && Boolean(data.user.email_confirmed_at)
              && data.user.email?.trim().toLowerCase() === saved.email;
          } catch { /* A failed identity check returns to email verification. */ }
          if (!alive.current || restoreId !== requestId.current) return;
          setEmail(saved.email);
          setMode(verified ? "new-password" : "reset");
          if (!verified) {
            setError("session_expired");
            try { sessionStorage.removeItem(storageKey(next)); } catch { /* Optional persistence. */ }
          }
        } else if ((saved.kind === "signup" || saved.kind === "recovery")
          && typeof saved.sentAt === "number" && saved.sentAt <= Date.now()
          && Date.now() - saved.sentAt < 86_400_000) {
          setEmail(saved.email);
          setMailStep(saved);
          setMode(saved.kind === "signup" ? "verify-signup" : "verify-recovery");
        } else if (saved.kind === "recovery-password") {
          setEmail(saved.email);
          setMode("reset");
          setError("session_expired");
          try { sessionStorage.removeItem(storageKey(next)); } catch { /* Optional persistence. */ }
        }
      }
      if (!alive.current || restoreId !== requestId.current) return;
      if (params.get("error") === "unverified") setError("confirmation_required");
      else if (params.has("error") && params.get("mode") !== "recovery") setError("failed");
      setReady(true);
    }
    void restore();
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        requestId.current += 1;
        pendingRef.current = null;
        setPending(null);
        void restore();
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      alive.current = false;
      requestId.current += 1;
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [classroomPath, isEnglish]);

  useEffect(() => {
    if (!mailStep) { setCooldown(0); return; }
    const refresh = () => setCooldown(Math.max(0, Math.ceil((mailStep.sentAt + 60_000 - Date.now()) / 1_000)));
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => window.clearInterval(timer);
  }, [mailStep]);

  useEffect(() => {
    if (previousMode.current !== mode) {
      previousMode.current = mode;
      panelRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    }
  }, [mode]);

  function clearMailStep() {
    setMailStep(null);
    try { sessionStorage.removeItem(storageKey(nextPath)); } catch { /* Optional persistence. */ }
  }

  function changeMode(next: Mode) {
    if (pendingRef.current || next === mode) return;
    clearMailStep();
    setMode(next);
    setError(null);
    setNotice("");
    setPassword("");
    setShowPassword(false);
    setCode("");
  }

  function showEmailCheck(kind: MailStep["kind"]) {
    const step: MailStep = { kind, email: email.trim().toLowerCase(), sentAt: Date.now() };
    setEmail(step.email);
    setMailStep(step);
    setPassword("");
    setCode("");
    setShowPassword(false);
    setMode(kind === "signup" ? "verify-signup" : "verify-recovery");
    try { sessionStorage.setItem(storageKey(nextPath), JSON.stringify(step)); } catch { /* Optional persistence. */ }
  }

  function redirectTo(recovery = false) {
    return `${window.location.origin}/auth/callback?${recovery ? "type=recovery&" : ""}next=${encodeURIComponent(languageSwitchUrl(nextPath, locale))}`;
  }

  async function runAction(kind: Exclude<Pending, null>, action: () => Promise<EmailAuthResult>, onSuccess: (result: Extract<EmailAuthResult, { ok: true }>) => void | Promise<void>) {
    if (pendingRef.current || !ready) return;
    pendingRef.current = kind;
    setPending(kind);
    setError(null);
    setNotice("");
    const id = ++requestId.current;
    try {
      const result = await action();
      if (!alive.current || id !== requestId.current) return;
      if (result.ok) await onSuccess(result);
      else setError(result.code);
    } catch {
      if (alive.current && id === requestId.current) setError("network");
    } finally {
      if (alive.current && id === requestId.current) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  }

  function continueToClassroom() {
    clearMailStep();
    setPassword("");
    setCode("");
    window.location.assign(languageSwitchUrl(getSafeAuthNext(nextPath, classroomPath), locale));
  }

  async function showNewPassword() {
    const id = requestId.current;
    const normalizedEmail = email.trim().toLowerCase();
    let current;
    try { current = await createClient().auth.getUser(); } catch {
      if (alive.current && id === requestId.current) {
        clearMailStep();
        setCode("");
        setMode("reset");
        setError("session_expired");
      }
      return;
    }
    if (!alive.current || id !== requestId.current) return;
    clearMailStep();
    setCode("");
    const user = current.data.user;
    if (current.error || !user?.email_confirmed_at || user.email?.trim().toLowerCase() !== normalizedEmail) {
      setMode("reset");
      setError("session_expired");
      return;
    }
    const step: RecoveryPasswordStep = { kind: "recovery-password", email: normalizedEmail, userId: user.id, verifiedAt: Date.now() };
    try { sessionStorage.setItem(storageKey(nextPath), JSON.stringify(step)); } catch { /* Optional persistence. */ }
    setMode("new-password");
  }

  async function authenticateWithGoogle() {
    if (pendingRef.current || !ready) return;
    pendingRef.current = "google";
    setPending("google");
    setError(null);
    setNotice("");
    const id = ++requestId.current;
    try {
      const { error: authError } = await createClient().auth.signInWithOAuth({
        provider: "google", options: { redirectTo: redirectTo() },
      });
      if (authError) throw authError;
    } catch {
      if (alive.current && id === requestId.current) {
        pendingRef.current = null;
        setPending(null);
        setError("network");
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runAction("submit", () => {
      const client = createClient();
      if (mode === "signup") {
        trackAnalyticsEvent("auth_started", { locale, placement: "login" });
        return signupWithEmail(client, { email, password, redirectTo: redirectTo() });
      }
      if (mode === "login") {
        trackAnalyticsEvent("auth_started", { locale, placement: "login" });
        return signInWithEmail(client, { email, password });
      }
      if (mode === "reset") return requestPasswordReset(client, { email, redirectTo: redirectTo(true) });
      if (mode === "verify-signup") return verifySignupCode(client, { email, code });
      if (mode === "verify-recovery") return verifyRecoveryCode(client, { email, code });
      return updatePassword(client, { password });
    }, async (result) => {
      if (result.status === "sent") showEmailCheck(mode === "reset" ? "recovery" : "signup");
      else if (result.status === "recovery_verified") await showNewPassword();
      else if (result.status === "password_updated") {
        clearMailStep();
        setPassword("");
        setMode("complete");
      } else {
        if (mode === "verify-signup") {
          // Code confirmation happens here, not in /auth/callback. Only the
          // server's auth.users marker can identify a real new account. Never
          // pass email, verification code or a client-selected user ID.
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 5000);
          try {
            await fetch("/api/analytics/signup/finalize", {
              method: "POST", credentials: "same-origin", signal: controller.signal,
            });
          } catch { /* Optional measurement must not block successful sign-in. */ }
          finally { window.clearTimeout(timeout); }
          if (!alive.current) return;
        }
        continueToClassroom();
      }
    });
  }

  function resend() {
    if (cooldown > 0) return;
    const recovery = mode === "verify-recovery";
    void runAction("resend", () => recovery
      ? requestPasswordReset(createClient(), { email, redirectTo: redirectTo(true) })
      : resendSignupCode(createClient(), { email, redirectTo: redirectTo() }), () => {
      showEmailCheck(recovery ? "recovery" : "signup");
      setNotice(isEnglish ? "A new code was requested. Check your inbox and spam folder." : "인증번호를 다시 요청했어요. 받은 편지함과 스팸함을 확인해 주세요.");
    });
  }

  const heading = isEnglish
    ? { login: "Welcome back to Lecue", signup: "Start with Lecue", "verify-signup": "Check your email", reset: "Forgot your password?", "verify-recovery": "Check your email", "new-password": "Choose a new password", complete: "Password updated" }[mode]
    : { login: "Lecue에 로그인", signup: "Lecue 시작하기", "verify-signup": "이메일을 확인해 주세요", reset: "비밀번호를 잊으셨나요?", "verify-recovery": "이메일을 확인해 주세요", "new-password": "새 비밀번호를 설정하세요", complete: "비밀번호를 변경했어요" }[mode];
  const description = isEnglish
    ? { login: "Your lectures and questions, together.", signup: "Verify your email once. Then sign in with your password.", "verify-signup": "Enter the code to finish creating your account.", reset: "We’ll send a code to verify it’s you.", "verify-recovery": "Enter the code to set a new password.", "new-password": "Use at least 8 characters.", complete: "You’re ready to return to your lectures." }[mode]
    : { login: "내 강의와 질문을 이어서 보세요.", signup: "처음 한 번 이메일을 인증하면 가입이 완료돼요.", "verify-signup": "인증번호를 입력하면 가입이 완료돼요.", reset: "본인 확인을 위한 인증번호를 보내드릴게요.", "verify-recovery": "인증번호를 입력한 뒤 비밀번호를 바꿀 수 있어요.", "new-password": "8자 이상의 비밀번호를 입력해 주세요.", complete: "이제 새 비밀번호로 로그인할 수 있어요." }[mode];
  const submitLabel = isEnglish
    ? { login: "Sign in", signup: "Verify email", "verify-signup": "Verify and continue", reset: "Send verification code", "verify-recovery": "Verify code", "new-password": "Save password", complete: "Continue to Lecue" }[mode]
    : { login: "로그인", signup: "이메일 인증하기", "verify-signup": "인증하고 시작하기", reset: "인증번호 받기", "verify-recovery": "인증번호 확인", "new-password": "비밀번호 저장", complete: "Lecue로 계속하기" }[mode];

  return (
    <main className="login-shell email-login-shell">
      <header className="login-topbar">
        <Link className="brand brand-lockup" href={basePath || "/"}><span className="lecue-symbol" aria-hidden="true" />Lecue</Link>
        <nav className="login-nav" aria-label={isEnglish ? "Login navigation" : "로그인 화면 메뉴"}>
          <SiteLanguageMenu locale={locale} region={region} href={`${basePath}/login?next=${encodeURIComponent(nextPath)}`} />
          <Link className="login-home-link" href={basePath || "/"}>{isEnglish ? "Back home" : "홈으로"}</Link>
        </nav>
      </header>

      <section className="login-stage" aria-labelledby="login-title">
        <div ref={panelRef} className="login-panel" aria-busy={Boolean(pending)}>
          {!isEntry && mode !== "complete" && (
            <button className="email-back" type="button" disabled={busy} onClick={() => changeMode("login")}>
              <ArrowLeft size={16} aria-hidden="true" />{isEnglish ? "Back to sign in" : "로그인으로"}
            </button>
          )}
          <div key={mode} className="email-auth-stage">
            <div className="auth-heading">
              {(isVerification || mode === "complete") && <div className="email-step-mark" aria-hidden="true">{mode === "complete" ? <Check size={24} /> : <Mail size={24} />}</div>}
              <h1 id="login-title">{heading}</h1>
              <p>{description}</p>
            </div>

            {isEntry && <>
              <div className="email-mode-switch" aria-label={isEnglish ? "Account access" : "로그인 또는 회원가입"}>
                <button type="button" aria-pressed={mode === "login"} disabled={busy} onClick={() => changeMode("login")}>{isEnglish ? "Sign in" : "로그인"}</button>
                <button type="button" aria-pressed={mode === "signup"} disabled={busy} onClick={() => changeMode("signup")}>{isEnglish ? "Create account" : "회원가입"}</button>
              </div>
              <button type="button" className="google-auth-button" onClick={authenticateWithGoogle} disabled={busy}>
                <GoogleMark /><span>{pending === "google" ? isEnglish ? "Opening Google…" : "Google로 이동 중…" : isEnglish ? "Continue with Google" : "Google로 계속하기"}</span>
                <span className="auth-button-end" aria-hidden="true">{pending === "google" && <i className="auth-spinner auth-spinner-dark" />}</span>
              </button>
              <div className="email-divider"><span>{isEnglish ? "or with email" : "또는 이메일로"}</span></div>
            </>}

            {isVerification && <div className="email-recipient">
              <strong>{email.split("@")[0]}<wbr />@{email.split("@").slice(1).join("@")}</strong>
              <button type="button" disabled={busy} onClick={() => changeMode(mode === "verify-signup" ? "signup" : "reset")}>{isEnglish ? "Change email" : "이메일 변경"}</button>
            </div>}

            {mode !== "complete" && <form className="email-auth-form" onSubmit={submit}>
              {(isEntry || mode === "reset") && <label className="email-field" htmlFor="auth-email">
                <span>{isEnglish ? "Email" : "이메일"}</span>
                <input id="auth-email" name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} required maxLength={320} placeholder="you@example.com" value={email} disabled={busy} onChange={event => { setEmail(event.target.value); setError(null); }} />
              </label>}

              {(isEntry || mode === "new-password") && <div className="email-field">
                <div className="email-label-row">
                  <label htmlFor="auth-password">{mode === "new-password" ? isEnglish ? "New password" : "새 비밀번호" : isEnglish ? "Password" : "비밀번호"}</label>
                  {mode === "login" && <button type="button" className="email-text-button" disabled={busy} onClick={() => changeMode("reset")}>{isEnglish ? "Forgot password?" : "비밀번호 찾기"}</button>}
                </div>
                <div className="email-password-wrap">
                  <input id="auth-password" name="password" type={showPassword ? "text" : "password"} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "login" ? undefined : MIN_PASSWORD_LENGTH} value={password} disabled={busy} aria-describedby={mode === "signup" ? "auth-password-hint" : undefined} onChange={event => { setPassword(event.target.value); setError(null); }} />
                  <button type="button" className="email-password-toggle" aria-label={showPassword ? isEnglish ? "Hide password" : "비밀번호 숨기기" : isEnglish ? "Show password" : "비밀번호 보기"} aria-pressed={showPassword} disabled={busy} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}</button>
                </div>
                {mode === "signup" && <small id="auth-password-hint">{isEnglish ? "At least 8 characters" : "8자 이상"}</small>}
              </div>}

              {isVerification && <label className="email-field" htmlFor="auth-code">
                <span id="auth-code-label">{isEnglish ? "8-digit verification code" : "8자리 인증번호"}</span>
                <input id="auth-code" name="code" className="email-code-input" type="text" inputMode="numeric" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} required pattern={`[0-9]{${EMAIL_CODE_LENGTH}}`} maxLength={EMAIL_CODE_LENGTH} value={code} disabled={busy} aria-labelledby="auth-code-label" aria-describedby="auth-code-hint" onChange={event => { setCode(event.target.value.replace(/\D/g, "").slice(0, EMAIL_CODE_LENGTH)); setError(null); }} onPaste={event => {
                  event.preventDefault();
                  setCode(event.clipboardData.getData("text").replace(/\D/g, "").slice(0, EMAIL_CODE_LENGTH));
                  setError(null);
                }} />
                <small id="auth-code-hint">{isEnglish ? "Use the latest code in your email." : "이메일에 있는 가장 최근 인증번호를 입력해 주세요."}</small>
              </label>}

              <button className="email-submit" type="submit" disabled={busy}>{pending === "submit" && <i className="auth-spinner" aria-hidden="true" />}<span>{pending === "submit" ? isEnglish ? "Please wait…" : "확인 중…" : submitLabel}</span></button>
            </form>}

            {mode === "complete" && <button className="email-submit" type="button" onClick={continueToClassroom}>{submitLabel}</button>}
            <div className="email-feedback" aria-live="polite" aria-atomic="true">
              {error && <p className="email-error" role="alert">{emailAuthErrorMessage(error, isEnglish)}</p>}
              {notice && <p className="email-notice" role="status">{notice}</p>}
            </div>
            {error === "confirmation_required" && mode === "login" && <button type="button" className="email-resend-confirmation" disabled={busy || cooldown > 0} onClick={resend}>{pending === "resend" ? isEnglish ? "Requesting code…" : "인증번호 요청 중…" : isEnglish ? "Send verification code" : "인증번호 받기"}</button>}
            {isVerification && <div className="email-resend-row">
              <p>{isEnglish ? "Can’t find the email? Check your spam folder." : "메일이 보이지 않으면 스팸함도 확인해 주세요."}</p>
              <button type="button" className="email-text-button" disabled={busy || cooldown > 0} onClick={resend}>{pending === "resend" ? isEnglish ? "Requesting code…" : "인증번호 요청 중…" : cooldown > 0 ? isEnglish ? `Resend in ${cooldown}s` : `${cooldown}초 후 다시 받기` : isEnglish ? "Resend code" : "인증번호 다시 받기"}</button>
              {mode === "verify-signup" && <p className="email-existing-account">{isEnglish ? "Already have an account?" : "이미 가입한 이메일인가요?"} <button type="button" className="email-text-button" disabled={busy} onClick={() => changeMode("login")}>{isEnglish ? "Sign in" : "로그인"}</button></p>}
            </div>}
            {mode === "new-password" && error === "session_expired" && <button type="button" className="email-resend-confirmation" disabled={busy} onClick={() => changeMode("reset")}>{isEnglish ? "Verify email again" : "이메일 다시 인증하기"}</button>}
            {mode === "signup" && <p className="auth-start-note">{isEnglish ? "Start with free credits. No card needed." : "무료 credits로 시작해요. 카드 등록 없이."}</p>}
          </div>

          {isEntry && <p className="auth-consent">
            <Link href={`${basePath}/terms`}>{isEnglish ? "Terms of Service" : "이용약관"}</Link>
            <span aria-hidden="true">·</span>
            <Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link>
          </p>}
        </div>
      </section>
    </main>
  );
}
