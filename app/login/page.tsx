"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";

import { getSafeAuthNext } from "../lib/auth-redirect";
import { createClient } from "../lib/supabase/client";

type Mode = "signin" | "signup";
type PendingAction = "google" | Mode | null;

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

export default function LoginPage({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const isEnglish = locale === "en";
  const basePath = isEnglish ? "/en" : "";
  const classroomPath = `${basePath}/classroom`;
  const [nextPath, setNextPath] = useState(classroomPath);
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const pending = pendingAction !== null;
  const pendingMessage = pendingAction === "google"
    ? isEnglish ? "Opening Google securely…" : "Google 로그인 화면을 여는 중입니다…"
    : pendingAction === "signin"
      ? isEnglish ? "Signing you in…" : "로그인 정보를 확인하는 중입니다…"
      : pendingAction === "signup"
        ? isEnglish ? "Creating your account…" : "계정을 만드는 중입니다…"
        : "";

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    setNextPath(getSafeAuthNext(searchParams.get("next"), classroomPath));
    if (searchParams.get("mode") === "signup") setMode("signup");
    if (searchParams.has("error")) {
      setIsError(true);
      setMessage(isEnglish
        ? "We could not complete sign-in. Please try again."
        : "로그인을 완료하지 못했습니다. 다시 시도해 주세요.");
    }
  }, [isEnglish]);

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setPassword("");
    setPasswordConfirmation("");
    setConfirmationEmail("");
    setMessage("");
    setIsError(false);
  }

  async function authenticateWithGoogle() {
    setPendingAction("google");
    setMessage("");
    setIsError(false);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}` },
      });
      if (error) throw error;
    } catch {
      setPendingAction(null);
      setIsError(true);
      setMessage(isEnglish
        ? "Google sign-in is not available. Check the Google provider in Supabase."
        : "Google 로그인을 사용할 수 없습니다. Supabase의 Google 공급자 설정을 확인해 주세요.");
    }
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedEmail = String(formData.get("email") ?? "").trim();
    const submittedPassword = String(formData.get("password") ?? "");
    const submittedConfirmation = String(formData.get("password-confirmation") ?? "");

    setEmail(submittedEmail);
    setPassword(submittedPassword);
    setPasswordConfirmation(submittedConfirmation);

    if (!submittedEmail || !submittedPassword) {
      setIsError(true);
      setMessage(isEnglish ? "Enter your email and password." : "이메일과 비밀번호를 입력해 주세요.");
      return;
    }
    if (!submittedEmail.includes("@")) {
      setIsError(true);
      setMessage(isEnglish ? "Enter a valid email address." : "올바른 이메일 주소를 입력해 주세요.");
      return;
    }
    if (mode === "signup" && submittedPassword.length < 8) {
      setIsError(true);
      setMessage(isEnglish ? "Use a password with at least 8 characters." : "비밀번호는 8자 이상 입력해 주세요.");
      return;
    }
    if (mode === "signup" && submittedPassword !== submittedConfirmation) {
      setIsError(true);
      setMessage(isEnglish ? "The passwords do not match." : "비밀번호가 서로 다릅니다.");
      return;
    }

    setPendingAction(mode);
    setMessage("");
    setIsError(false);
    let redirecting = false;

    try {
      const supabase = createClient();
      const credentials = { email: submittedEmail, password: submittedPassword };
      const { data, error } = mode === "signup"
        ? await supabase.auth.signUp({
            ...credentials,
            options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}` },
          })
        : await supabase.auth.signInWithPassword(credentials);

      if (error) {
        const errorMessage = error.message.toLowerCase();
        const rateLimited = errorMessage.includes("rate limit");
        const emailUnconfirmed = errorMessage.includes("email not confirmed");
        setIsError(true);
        setMessage(emailUnconfirmed
          ? isEnglish
            ? "Your email is not confirmed yet. Open the confirmation link we sent when you signed up."
            : "이메일 확인이 아직 끝나지 않았습니다. 가입할 때 받은 확인 메일의 링크를 먼저 눌러 주세요."
          : rateLimited
            ? isEnglish ? "Too many emails were requested. Wait a few minutes and try again." : "인증 메일 요청이 너무 많습니다. 몇 분 뒤 다시 시도해 주세요."
            : mode === "signup"
              ? isEnglish ? "We could not create the account. Check your email and password." : "회원가입을 처리하지 못했습니다. 이메일과 비밀번호를 확인해 주세요."
              : isEnglish ? "The email or password is incorrect." : "이메일 또는 비밀번호가 올바르지 않습니다.");
        return;
      }

      if (data.session) {
        redirecting = true;
        window.location.assign(nextPath);
        return;
      }

      setConfirmationEmail(submittedEmail);
    } catch {
      setIsError(true);
      setMessage(isEnglish
        ? "We could not reach the authentication server. Check your connection and try again."
        : "인증 서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      if (!redirecting) setPendingAction(null);
    }
  }

  return (
    <main className="login-shell">
      <header className="login-topbar">
        <Link className="brand" href={basePath || "/"}>Lecue</Link>
        <nav className="login-nav" aria-label={isEnglish ? "Login navigation" : "로그인 화면 메뉴"}>
          <span>lecue.app</span>
          <Link href={isEnglish ? "/login" : "/en/login"}>{isEnglish ? "한국어" : "English"}</Link>
          <Link className="login-home-link" href={basePath || "/"}>{isEnglish ? "Back home" : "홈으로"}</Link>
        </nav>
      </header>

      <section className="login-stage" aria-labelledby="login-title">
        <div className="login-panel" aria-busy={pending}>
            {confirmationEmail ? (
              <div className="email-confirmation" role="status" aria-live="polite">
                <span>{isEnglish ? "Almost there" : "거의 다 됐어요"}</span>
                <h2>{isEnglish ? "Check your email" : "이메일을 확인해 주세요"}</h2>
                <p>
                  {isEnglish ? "We sent a confirmation link to " : "확인 링크를 "}
                  <strong>{confirmationEmail}</strong>
                  {isEnglish ? "." : " 주소로 보냈습니다."}
                </p>
                <p>{isEnglish
                  ? "Open the link to confirm your address, sign in, and enter your classroom. You cannot sign in with this account until confirmation is complete."
                  : "메일의 링크를 누르면 이메일 확인과 로그인이 완료되고 강의실로 이동합니다. 확인 전에는 같은 계정으로 로그인할 수 없습니다."}</p>
                <p className="email-confirmation-note">{isEnglish
                  ? "If you do not see it, check your spam folder."
                  : "메일이 보이지 않으면 스팸함도 확인해 주세요."}</p>
                <button type="button" onClick={() => changeMode("signin")}>
                  {isEnglish ? "Back to sign in" : "로그인 화면으로 돌아가기"}
                </button>
              </div>
            ) : (
              <>
              <div className="auth-heading">
                <h1 id="login-title">{mode === "signin"
                  ? isEnglish ? "Sign in to Lecue" : "Lecue에 로그인"
                  : isEnglish ? "Create your Lecue account" : "Lecue 계정 만들기"}</h1>
                <p>{mode === "signin"
                  ? isEnglish ? "Return to your classrooms and previous lectures." : "내 강의실과 지난 수업을 이어서 확인하세요."
                  : isEnglish ? "Google is the quickest way to get started." : "Google 계정으로 가장 빠르게 시작할 수 있습니다."}</p>
              </div>

              <button
                type="button"
                className="google-auth-button"
                onClick={authenticateWithGoogle}
                disabled={pending}
              >
                <GoogleMark />
                <span>{pendingAction === "google"
                  ? isEnglish ? "Opening Google…" : "Google로 이동 중…"
                  : isEnglish ? "Continue with Google" : "Google로 계속하기"}</span>
                <span className="auth-button-end" aria-hidden="true">
                  {pendingAction === "google" && <i className="auth-spinner auth-spinner-dark" />}
                </span>
              </button>

              <div className="auth-divider"><span>{isEnglish ? "or email" : "또는 이메일"}</span></div>

              <form className="login-form" onSubmit={authenticate} noValidate>
                <label htmlFor="email">{isEnglish ? "Email" : "이메일"}</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  disabled={pending}
                />

                <label htmlFor="password">{isEnglish ? "Password" : "비밀번호"}</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={mode === "signup" ? 8 : undefined}
                  required
                  disabled={pending}
                />

                {mode === "signup" && (
                  <>
                    <label htmlFor="password-confirmation">{isEnglish ? "Confirm password" : "비밀번호 확인"}</label>
                    <input
                      id="password-confirmation"
                      name="password-confirmation"
                      type="password"
                      autoComplete="new-password"
                      value={passwordConfirmation}
                      onChange={(event) => setPasswordConfirmation(event.target.value)}
                      minLength={8}
                      required
                      disabled={pending}
                    />
                  </>
                )}

                <button className="email-auth-button" type="submit" disabled={pending}>
                  <span>{pendingAction === mode
                    ? mode === "signin"
                      ? isEnglish ? "Signing in…" : "로그인 중…"
                      : isEnglish ? "Creating account…" : "계정 만드는 중…"
                    : mode === "signin"
                      ? isEnglish ? "Sign in with email" : "이메일로 로그인"
                      : isEnglish ? "Create account with email" : "이메일로 계정 만들기"}</span>
                  {pendingAction === mode && <i className="auth-spinner" aria-hidden="true" />}
                </button>
                <p
                  id="auth-message"
                  className={isError ? "login-message login-message-error" : "login-message"}
                  role={isError ? "alert" : "status"}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {message || pendingMessage || (mode === "signin"
                    ? isEnglish ? "Enter the email and password you used to sign up." : "가입한 이메일과 비밀번호를 입력하세요."
                    : isEnglish ? "Use at least 8 characters. Email verification is required once." : "8자 이상 입력하세요. 이메일 확인은 처음 한 번만 필요합니다.")}
                </p>
              </form>
              <p className="auth-consent">
                {isEnglish ? "By continuing, you acknowledge the " : "계속하면 "}
                <Link href={`${basePath}/terms`}>{isEnglish ? "Terms of Service" : "이용약관"}</Link>
                {isEnglish ? " and " : "과 "}
                <Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link>
                {isEnglish ? "." : "을 확인하고 동의한 것으로 봅니다."}
              </p>
              <p className="auth-switch">
                {mode === "signin"
                  ? isEnglish ? "New to Lecue?" : "아직 계정이 없나요?"
                  : isEnglish ? "Already have an account?" : "이미 계정이 있나요?"}
                <button type="button" disabled={pending} onClick={() => changeMode(mode === "signin" ? "signup" : "signin")}>
                  {mode === "signin"
                    ? isEnglish ? "Create account" : "회원가입"
                    : isEnglish ? "Sign in" : "로그인"}
                </button>
              </p>
              </>
            )}
        </div>
      </section>

      <footer className="login-footnote">
        <Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link>
        <Link href={`${basePath}/terms`}>{isEnglish ? "Terms of Service" : "이용약관"}</Link>
        <span>{isEnglish ? "Confirm recording permission before use" : "현장 녹음 권한을 확인한 뒤 사용하세요"}</span>
      </footer>
    </main>
  );
}
