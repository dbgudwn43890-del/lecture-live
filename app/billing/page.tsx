"use client";

import Link from "next/link";
import Script from "next/script";
import { useEffect, useRef, useState } from "react";

type Locale = "ko" | "en";
type Plan = "monthly" | "semester";
type CreditStatus = { credits: number; nextExpiry: string | null; latestGrantAt: string | null; subscriptionStatus: string | null; trialUsed: boolean };
type PaddleEvent = { name?: string };
type PaddleApi = {
  Environment: { set(environment: "sandbox"): void };
  Initialize(options: {
    token: string;
    checkout: { settings: { displayMode: "overlay"; variant: "one-page"; theme: "light"; locale: Locale } };
    eventCallback(event: PaddleEvent): void;
  }): void;
  Checkout: { open(options: { transactionId: string }): void };
};

declare global {
  interface Window { Paddle?: PaddleApi }
}

const copy = {
  ko: {
    title: "결제와 크레딧",
    description: "1크레딧으로 강의 1분을 기록합니다. 질문과 답변은 기록 시간에 포함됩니다.",
    credits: "남은 크레딧",
    unit: "분 기록 가능",
    expiry: "가장 가까운 만료일",
    monthly: "월간",
    monthlyPrice: "13,900원 / 월",
    monthlyCredits: "매월 4,800크레딧 · 약 80시간",
    trial: "처음 결제수단을 등록하면 7일 동안 수업 1회, 최대 180크레딧을 먼저 사용할 수 있습니다.",
    semester: "한 학기",
    semesterPrice: "74,900원 / 6개월",
    semesterCredits: "28,800크레딧 · 약 480시간",
    oneTime: "한 번 결제하며 자동 갱신되지 않습니다.",
    startTrial: "7일 무료로 시작",
    subscribe: "월간 시작",
    buy: "한 학기권 결제",
    methods: "한국에서는 카카오페이·네이버페이·국내 카드, 해외에서는 Apple Pay·Google Pay·PayPal과 현지 결제수단을 사용할 수 있습니다. 실제 표시 수단은 국가와 기기에 따라 달라집니다.",
    manage: "결제·구독 관리",
    classroom: "강의실로 돌아가기",
    processing: "결제 완료를 확인하고 크레딧을 반영하는 중입니다…",
    opening: "안전한 결제창을 여는 중입니다…",
    ready: "결제수단과 갱신 조건은 결제창에서 최종 확인할 수 있습니다.",
  },
  en: {
    title: "Billing and credits",
    description: "One credit records one minute of a lecture. Questions and answers are included in recording time.",
    credits: "Credits remaining",
    unit: "recording minutes",
    expiry: "Nearest expiry",
    monthly: "Monthly",
    monthlyPrice: "$9.99 / month",
    monthlyCredits: "4,800 credits each month · about 80 hours",
    trial: "Add a payment method to try one lecture for 7 days, with up to 180 credits before the first charge.",
    semester: "Semester",
    semesterPrice: "$54 / 6 months",
    semesterCredits: "28,800 credits · about 480 hours",
    oneTime: "One payment. It does not renew automatically.",
    startTrial: "Start 7-day trial",
    subscribe: "Start monthly",
    buy: "Buy semester pass",
    methods: "Available methods include Apple Pay, Google Pay, PayPal, cards, and eligible local payment methods. What appears depends on your country and device.",
    manage: "Manage billing",
    classroom: "Back to classroom",
    processing: "Confirming payment and adding your credits…",
    opening: "Opening secure checkout…",
    ready: "Payment and renewal terms are shown for final review in checkout.",
  },
} as const;

export default function BillingPage({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  const basePath = locale === "en" ? "/en" : "";
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [paddleReady, setPaddleReady] = useState(false);
  const [pending, setPending] = useState<Plan | "portal" | "webhook" | null>(null);
  const [message, setMessage] = useState<string>(t.ready);
  const initializedRef = useRef(false);
  const autoStartedRef = useRef(false);
  const creditsBeforeCheckoutRef = useRef(0);
  const grantBeforeCheckoutRef = useRef<string | null>(null);

  useEffect(() => { void loadStatus(); }, [locale]);

  useEffect(() => {
    if (!paddleReady || !status || autoStartedRef.current) return;
    const plan = new URLSearchParams(window.location.search).get("plan");
    if (plan === "monthly" || plan === "semester") {
      autoStartedRef.current = true;
      void startCheckout(plan);
    }
  }, [paddleReady, status]);

  async function loadStatus() {
    const response = await fetch("/api/credits", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json() as CreditStatus;
    setStatus(data);
    return data;
  }

  function initializePaddle() {
    if (initializedRef.current || !window.Paddle) return;
    const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    if (!token) {
      setMessage(locale === "en" ? "Checkout has not been configured yet." : "결제창 설정이 아직 완료되지 않았습니다.");
      return;
    }
    if (process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT === "sandbox") window.Paddle.Environment.set("sandbox");
    window.Paddle.Initialize({
      token,
      checkout: { settings: { displayMode: "overlay", variant: "one-page", theme: "light", locale } },
      eventCallback(event) {
        if (event.name === "checkout.completed") void waitForCredits();
      },
    });
    initializedRef.current = true;
    setPaddleReady(true);
  }

  async function waitForCredits() {
    setPending("webhook");
    setMessage(t.processing);
    const before = creditsBeforeCheckoutRef.current;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      const current = await loadStatus();
      if (current && (current.credits > before || current.latestGrantAt !== grantBeforeCheckoutRef.current)) {
        window.location.assign(`${basePath}/classroom?payment=success`);
        return;
      }
    }
    setPending(null);
    setMessage(locale === "en" ? "Payment completed. Credits are still syncing; refresh in a moment." : "결제는 완료됐습니다. 크레딧 반영 중이니 잠시 후 새로고침해 주세요.");
  }

  async function startCheckout(plan: Plan) {
    if (!window.Paddle || !paddleReady || pending) return;
    setPending(plan);
    setMessage(t.opening);
    creditsBeforeCheckoutRef.current = status?.credits ?? 0;
    grantBeforeCheckoutRef.current = status?.latestGrantAt ?? null;
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ plan }),
      });
      const data = await response.json() as { transactionId?: string; error?: string };
      if (!response.ok || !data.transactionId) throw new Error(data.error);
      window.Paddle.Checkout.open({ transactionId: data.transactionId });
      setMessage(t.ready);
    } catch (caught) {
      setMessage(caught instanceof Error && caught.message ? caught.message : locale === "en" ? "Could not open checkout." : "결제창을 열지 못했습니다.");
    } finally {
      setPending(null);
    }
  }

  async function openPortal() {
    if (pending) return;
    setPending("portal");
    try {
      const response = await fetch("/api/billing/portal", { method: "POST", headers: { "X-Site-Locale": locale } });
      const data = await response.json() as { url?: string; error?: string };
      if (!response.ok || !data.url) throw new Error(data.error);
      window.location.assign(data.url);
    } catch (caught) {
      setMessage(caught instanceof Error && caught.message ? caught.message : locale === "en" ? "Could not open billing settings." : "결제 관리 화면을 열지 못했습니다.");
      setPending(null);
    }
  }

  return (
    <main className="billing-shell">
      <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" strategy="afterInteractive" onLoad={initializePaddle} onReady={initializePaddle} />
      <header className="billing-topbar"><Link className="brand" href={basePath || "/"}>Lecue</Link><Link href={`${basePath}/classroom`}>{t.classroom}</Link></header>
      <section className="billing-stage" aria-labelledby="billing-title">
        <header className="billing-heading"><h1 id="billing-title">{t.title}</h1><p>{t.description}</p></header>
        <section className="credit-summary" aria-live="polite"><span>{t.credits}</span><strong>{status ? status.credits.toLocaleString(locale === "en" ? "en-US" : "ko-KR") : "—"}</strong><small>{t.unit}</small>{status?.nextExpiry && <time>{t.expiry} · {new Date(status.nextExpiry).toLocaleDateString(locale === "en" ? "en-US" : "ko-KR")}</time>}</section>
        <div className="billing-plans">
          <article className="billing-plan billing-plan-featured"><span>{t.monthly}</span><h2>{t.monthlyPrice}</h2><strong>{t.monthlyCredits}</strong><p>{t.trial}</p><button type="button" onClick={() => void startCheckout("monthly")} disabled={!paddleReady || !status || pending !== null}>{pending === "monthly" ? t.opening : status?.trialUsed ? t.subscribe : t.startTrial}</button></article>
          <article className="billing-plan"><span>{t.semester}</span><h2>{t.semesterPrice}</h2><strong>{t.semesterCredits}</strong><p>{t.oneTime}</p><button type="button" onClick={() => void startCheckout("semester")} disabled={!paddleReady || !status || pending !== null}>{pending === "semester" ? t.opening : t.buy}</button></article>
        </div>
        <p className="billing-methods">{t.methods}</p>
        <p className="billing-message" role="status">{pending && <i className="auth-spinner auth-spinner-dark" aria-hidden="true" />}{message}</p>
        {status?.subscriptionStatus && <button className="billing-manage" type="button" onClick={() => void openPortal()} disabled={pending !== null}>{t.manage}</button>}
      </section>
      <footer className="billing-footer"><Link href={`${basePath}/terms`}>{locale === "en" ? "Terms" : "이용약관"}</Link><Link href={`${basePath}/privacy`}>{locale === "en" ? "Privacy" : "개인정보처리방침"}</Link><span>Paddle secure checkout</span></footer>
    </main>
  );
}
