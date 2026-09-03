"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { getSafeAuthNext } from "../lib/auth-redirect";
import { createClient } from "../lib/supabase/client";

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

/**
 * Google 전용 로그인. 이메일·비밀번호 가입은 인증 메일 없이 아무 주소나
 * 통과시켜(ddd@ddd.com 실등록) 무료 크레딧 남용 통로였다. 동의(ACC-02/03)는
 * 강의실 첫 진입 게이트가 받는다.
 */
export default function LoginPage({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const isEnglish = locale === "en";
  const basePath = isEnglish ? "/en" : "";
  const classroomPath = `${basePath}/classroom`;
  const [nextPath, setNextPath] = useState(classroomPath);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    setNextPath(getSafeAuthNext(searchParams.get("next"), classroomPath));
    if (searchParams.has("error")) {
      setIsError(true);
      setMessage(isEnglish
        ? "We could not complete sign-in. Please try again."
        : "로그인을 완료하지 못했습니다. 다시 시도해 주세요.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEnglish]);

  useEffect(() => {
    // Cancelling at Google and pressing Back restores this page from bfcache
    // with pending still set, which leaves the button disabled until a reload.
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) setPending(false);
    }
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  async function authenticateWithGoogle() {
    setPending(true);
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
      setPending(false);
      setIsError(true);
      setMessage(isEnglish
        ? "Google sign-in is not available. Check the Google provider in Supabase."
        : "Google 로그인을 사용할 수 없습니다. Supabase의 Google 공급자 설정을 확인해 주세요.");
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
          <div className="auth-heading">
            <span className="auth-kicker">{isEnglish ? "Live lecture assistant" : "현장 강의를 위한 실시간 조교"}</span>
            <h1 id="login-title">{isEnglish ? "Sign in to Lecue" : "Lecue에 로그인"}</h1>
            <p>{isEnglish
              ? "One Google account for sign-up and sign-in."
              : "가입과 로그인 모두 Google 계정 하나면 됩니다."}</p>
          </div>

          <button
            type="button"
            className="google-auth-button"
            onClick={authenticateWithGoogle}
            disabled={pending}
          >
            <GoogleMark />
            <span>{pending
              ? isEnglish ? "Opening Google…" : "Google로 이동 중…"
              : isEnglish ? "Continue with Google" : "Google로 계속하기"}</span>
            <span className="auth-button-end" aria-hidden="true">
              {pending && <i className="auth-spinner auth-spinner-dark" />}
            </span>
          </button>

          {/* 폼이 빠진 자리를 계정이 받는 것으로 채운다. 과금을 암시하는
              문구(무료·크레딧)는 어디에도 쓰지 않는다. */}
          <ul className="login-perks">
            <li>{isEnglish ? "Live transcription that follows the lecture" : "강의를 따라가는 실시간 받아쓰기"}</li>
            <li>{isEnglish ? "Ask the moment you get lost — answered from this lecture" : "놓친 순간 바로 질문 — 이 수업의 내용으로 답합니다"}</li>
            <li>{isEnglish ? "A structured review note after every lecture" : "수업이 끝나면 정리된 복습 노트"}</li>
          </ul>

          <p
            id="auth-message"
            className={isError ? "login-message login-message-error" : "login-message"}
            role={isError ? "alert" : "status"}
            aria-live="polite"
            aria-atomic="true"
          >
            {message || (pending
              ? isEnglish ? "Opening Google securely…" : "Google 로그인 화면을 여는 중입니다…"
              : "")}
          </p>

          <p className="auth-consent">
            {isEnglish ? "By continuing, you acknowledge the " : "계속하면 "}
            <Link href={`${basePath}/terms`}>{isEnglish ? "Terms of Service" : "이용약관"}</Link>
            {isEnglish ? " and " : "과 "}
            <Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link>
            {isEnglish ? "." : "을 확인하고 동의한 것으로 봅니다."}
          </p>
        </div>
      </section>
    </main>
  );
}
