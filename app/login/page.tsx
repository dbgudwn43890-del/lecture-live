"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";

import { createClient } from "../lib/supabase/client";

type Mode = "signin" | "signup";

export default function LoginPage({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const isEnglish = locale === "en";
  const basePath = isEnglish ? "/en" : "";
  const classroomPath = `${basePath}/classroom`;
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [googlePending, setGooglePending] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState("");

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("error")) {
      setIsError(true);
      setMessage(isEnglish
        ? "We could not complete sign-in. Please try again."
        : "로그인을 완료하지 못했습니다. 다시 시도해 주세요.");
    }
  }, []);

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setPassword("");
    setPasswordConfirmation("");
    setConfirmationEmail("");
    setMessage("");
    setIsError(false);
  }

  async function authenticateWithGoogle() {
    setPending(true);
    setGooglePending(true);
    setMessage("");
    setIsError(false);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(classroomPath)}` },
      });
      if (error) throw error;
    } catch {
      setPending(false);
      setGooglePending(false);
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

    setPending(true);
    setMessage("");
    setIsError(false);

    try {
      const supabase = createClient();
      const credentials = { email: submittedEmail, password: submittedPassword };
      const { data, error } = mode === "signup"
        ? await supabase.auth.signUp({
            ...credentials,
            options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(classroomPath)}` },
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
        window.location.assign(classroomPath);
        return;
      }

      setConfirmationEmail(submittedEmail);
    } catch {
      setIsError(true);
      setMessage(isEnglish
        ? "We could not reach the authentication server. Check your connection and try again."
        : "인증 서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-shell">
      <header className="login-topbar">
        <Link className="brand" href={basePath || "/"}>Lecue</Link>
        <span>{isEnglish ? "For in-person learners" : "현장 강의 참여자 입장"}</span>
      </header>

      <section className="login-stage" aria-labelledby="login-title">
        <div className="login-intro">
          {/* deslop-ignore-next-line 10 -- 반복 장식이 아닌 제품 범주 라벨 */}
          <span className="login-kicker">LIVE LECTURE ASSISTANT</span>
          <h1 id="login-title">{isEnglish ? "Enter your classroom" : "강의실에 들어가기"}</h1>
          <p>{isEnglish
            ? "Continue with Google, or verify your email once when you create an account."
            : "Google 계정으로 바로 시작하거나, 이메일 가입은 처음 한 번만 확인합니다."}</p>
        </div>

        <div className="login-panel">
          {confirmationEmail ? (
            <div className="email-confirmation" role="status" aria-live="polite">
              <span>{isEnglish ? "ONE LAST STEP" : "마지막 한 단계"}</span>
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
              <button
                type="button"
                className="google-auth-button"
                onClick={authenticateWithGoogle}
                disabled={pending}
              >
                {googlePending
                  ? isEnglish ? "Opening Google…" : "Google로 이동 중…"
                  : isEnglish ? "Continue with Google" : "Google로 계속하기"}
              </button>

              <div className="auth-divider"><span>{isEnglish ? "or email" : "또는 이메일"}</span></div>

              <div className="auth-mode" aria-label={isEnglish ? "Account options" : "계정 메뉴"}>
                <button
                  type="button"
                  className={mode === "signin" ? "auth-mode-active" : undefined}
                  aria-pressed={mode === "signin"}
                  disabled={pending}
                  onClick={() => changeMode("signin")}
                >
                  {isEnglish ? "Sign in" : "로그인"}
                </button>
                <button
                  type="button"
                  className={mode === "signup" ? "auth-mode-active" : undefined}
                  aria-pressed={mode === "signup"}
                  disabled={pending}
                  onClick={() => changeMode("signup")}
                >
                  {isEnglish ? "Create account" : "회원가입"}
                </button>
              </div>

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

                <button type="submit" disabled={pending}>
                  {pending
                    ? isEnglish ? "Working…" : "처리 중…"
                    : mode === "signin"
                      ? isEnglish ? "Sign in" : "로그인"
                      : isEnglish ? "Create account" : "회원가입"}
                </button>
                <p className={isError ? "login-message login-message-error" : "login-message"} aria-live="polite">
                  {message || (mode === "signin"
                    ? isEnglish ? "Enter the email and password you used to sign up." : "가입한 이메일과 비밀번호를 입력하세요."
                    : isEnglish ? "Use a password with at least 8 characters." : "비밀번호는 8자 이상 입력하세요.")}
                </p>
              </form>
              <p className="auth-consent">
                {isEnglish ? "By continuing, you acknowledge the " : "Google 또는 회원가입을 계속하면 "}
                <Link href={`${basePath}/terms`}>{isEnglish ? "Terms of Service" : "이용약관"}</Link>
                {isEnglish ? " and " : "과 "}
                <Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link>
                {isEnglish ? "." : "을 확인하고 동의한 것으로 봅니다."}
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
