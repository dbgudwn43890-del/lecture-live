"use client";

import { FormEvent, useEffect, useState } from "react";

import { createClient } from "../lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("error")) {
      setIsError(true);
      setMessage("로그인 링크가 만료되었거나 이미 사용되었습니다. 새 링크를 받아 주세요.");
    }
  }, []);

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setIsError(false);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    setPending(false);
    setIsError(Boolean(error));
    setMessage(
      error
        ? "로그인 링크를 보내지 못했습니다. 이메일 주소를 확인하고 다시 시도해 주세요."
        : "로그인 링크를 보냈습니다. 받은 편지함을 확인해 주세요.",
    );
  }

  return (
    <main className="login-shell">
      <header className="login-topbar">
        <span className="brand">Lecture Live</span>
        <span>현장 강의 참여자 입장</span>
      </header>

      <section className="login-stage" aria-labelledby="login-title">
        <div className="login-intro">
          <span className="login-kicker">LIVE LECTURE ASSISTANT</span>
          <h1 id="login-title">강의실에 들어가기</h1>
          <p>이메일로 받은 링크를 누르면 바로 실시간 스크립트와 질문 화면이 열립니다.</p>
        </div>

        <form className="login-form" onSubmit={sendMagicLink}>
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
          <button type="submit" disabled={pending || !email.trim()}>
            {pending ? "보내는 중…" : "로그인 링크 받기"}
          </button>
          <p className={isError ? "login-message login-message-error" : "login-message"} aria-live="polite">
            {message || "비밀번호는 필요하지 않습니다."}
          </p>
        </form>
      </section>

      <footer className="login-footnote">현장 녹음 권한을 확인한 뒤 사용하세요</footer>
    </main>
  );
}
