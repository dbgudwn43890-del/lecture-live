"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";

import { createClient } from "../lib/supabase/client";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [googlePending, setGooglePending] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("error")) {
      setIsError(true);
      setMessage("로그인을 완료하지 못했습니다. 다시 시도해 주세요.");
    }
  }, []);

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setPassword("");
    setPasswordConfirmation("");
    setMessage("");
    setIsError(false);
  }

  async function authenticateWithGoogle() {
    setPending(true);
    setGooglePending(true);
    setMessage("");
    setIsError(false);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });

    if (error) {
      setPending(false);
      setGooglePending(false);
      setIsError(true);
      setMessage("Google 로그인을 시작하지 못했습니다. 다시 시도해 주세요.");
    }
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "signup" && password !== passwordConfirmation) {
      setIsError(true);
      setMessage("비밀번호가 서로 다릅니다.");
      return;
    }

    setPending(true);
    setMessage("");
    setIsError(false);

    const supabase = createClient();
    const credentials = { email: email.trim(), password };
    const { data, error } = mode === "signup"
      ? await supabase.auth.signUp({
          ...credentials,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        })
      : await supabase.auth.signInWithPassword(credentials);

    setPending(false);
    if (error) {
      setIsError(true);
      setMessage(
        mode === "signup"
          ? "회원가입을 처리하지 못했습니다. 이메일과 비밀번호를 확인해 주세요."
          : "이메일 또는 비밀번호가 올바르지 않습니다.",
      );
      return;
    }

    if (data.session) {
      window.location.assign("/classroom");
      return;
    }

    setMessage("확인 메일을 보냈습니다. 처음 한 번만 이메일 확인이 필요합니다.");
  }

  return (
    <main className="login-shell">
      <header className="login-topbar">
        <Link className="brand" href="/">Lecture Live</Link>
        <span>현장 강의 참여자 입장</span>
      </header>

      <section className="login-stage" aria-labelledby="login-title">
        <div className="login-intro">
          <span className="login-kicker">LIVE LECTURE ASSISTANT</span>
          <h1 id="login-title">강의실에 들어가기</h1>
          <p>Google 계정으로 바로 시작하거나, 이메일 가입은 처음 한 번만 확인합니다.</p>
        </div>

        <div className="login-panel">
          <button
            type="button"
            className="google-auth-button"
            onClick={authenticateWithGoogle}
            disabled={pending}
          >
            {googlePending ? "Google로 이동 중…" : "Google로 계속하기"}
          </button>

          <div className="auth-divider"><span>또는 이메일</span></div>

          <div className="auth-mode" aria-label="계정 메뉴">
            <button
              type="button"
              className={mode === "signin" ? "auth-mode-active" : undefined}
              aria-pressed={mode === "signin"}
              onClick={() => changeMode("signin")}
            >
              로그인
            </button>
            <button
              type="button"
              className={mode === "signup" ? "auth-mode-active" : undefined}
              aria-pressed={mode === "signup"}
              onClick={() => changeMode("signup")}
            >
              회원가입
            </button>
          </div>

          <form className="login-form" onSubmit={authenticate}>
            <label htmlFor="email">이메일</label>
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

            <label htmlFor="password">비밀번호</label>
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
                <label htmlFor="password-confirmation">비밀번호 확인</label>
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

            <button type="submit" disabled={pending || !email.trim() || !password}>
              {pending ? "처리 중…" : mode === "signin" ? "로그인" : "회원가입"}
            </button>
            <p className={isError ? "login-message login-message-error" : "login-message"} aria-live="polite">
              {message || (mode === "signin" ? "가입한 이메일과 비밀번호를 입력하세요." : "비밀번호는 8자 이상 입력하세요.")}
            </p>
          </form>
          <p className="auth-consent">
            Google 또는 회원가입을 계속하면 <Link href="/terms">이용약관</Link>과{" "}
            <Link href="/privacy">개인정보처리방침</Link>을 확인하고 동의한 것으로 봅니다.
          </p>
        </div>
      </section>

      <footer className="login-footnote">
        <Link href="/privacy">개인정보처리방침</Link>
        <Link href="/terms">이용약관</Link>
        <span>현장 녹음 권한을 확인한 뒤 사용하세요</span>
      </footer>
    </main>
  );
}
