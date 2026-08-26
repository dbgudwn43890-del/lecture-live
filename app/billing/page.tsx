"use client";

import Link from "next/link";
import Script from "next/script";
import { useEffect, useRef, useState } from "react";

import { usePaddleCheckout, type BillingPlan } from "../lib/use-paddle-checkout";

type Locale = "ko" | "en";
type CreditStatus = { credits: number; nextExpiry: string | null; latestGrantAt: string | null; subscriptionStatus: string | null; trialUsed: boolean };

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
    trial: "처음 결제수단을 등록하면 7일 동안 180크레딧을 여러 수업에 나눠 사용할 수 있습니다.",
    term: "4개월",
    termPrice: "49,900원 / 4개월",
    termCredits: "19,200크레딧 · 약 320시간",
    semester: "한 학기",
    semesterPrice: "70,900원 / 6개월",
    semesterCredits: "28,800크레딧 · 약 480시간",
    oneTime: "한 번 결제하며 자동 갱신되지 않습니다.",
    startTrial: "7일 무료로 시작",
    subscribe: "월간 시작",
    buyTerm: "4개월권 결제",
    buy: "한 학기권 결제",
    methods: "한국에서는 카카오페이·네이버페이·국내 카드, 해외에서는 Apple Pay·Google Pay·PayPal과 현지 결제수단을 사용할 수 있습니다. 실제 표시 수단은 국가와 기기에 따라 달라집니다.",
    manage: "결제·구독 관리",
    classroom: "강의실로 돌아가기",
    opening: "안전한 결제창을 여는 중입니다…",
    ready: "결제수단과 갱신 조건은 결제창에서 최종 확인할 수 있습니다.",
    portalFailed: "결제 관리 화면을 열지 못했습니다.",
    statusFailed: "크레딧 정보를 불러오지 못했습니다. 결제는 그대로 진행할 수 있습니다.",
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
    trial: "Add a payment method to use 180 credits across multiple lectures during the 7-day trial.",
    term: "4 months",
    termPrice: "$35.99 / 4 months",
    termCredits: "19,200 credits · about 320 hours",
    semester: "Semester",
    semesterPrice: "$50.99 / 6 months",
    semesterCredits: "28,800 credits · about 480 hours",
    oneTime: "One payment. It does not renew automatically.",
    startTrial: "Start 7-day trial",
    subscribe: "Start monthly",
    buyTerm: "Buy 4-month pass",
    buy: "Buy semester pass",
    methods: "Available methods include Apple Pay, Google Pay, PayPal, cards, and eligible local payment methods. What appears depends on your country and device.",
    manage: "Manage billing",
    classroom: "Back to classroom",
    opening: "Opening secure checkout…",
    ready: "Payment and renewal terms are shown for final review in checkout.",
    portalFailed: "Could not open billing settings.",
    statusFailed: "Could not load your credit balance. You can still continue to checkout.",
  },
} as const;

export default function BillingPage({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  const basePath = locale === "en" ? "/en" : "";
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [portalPending, setPortalPending] = useState(false);
  const [portalMessage, setPortalMessage] = useState("");
  const autoStartedRef = useRef(false);

  const { ready, pending, message, initializePaddle, startCheckout } = usePaddleCheckout(locale, () => {
    window.location.assign(`${basePath}/classroom?payment=success`);
  });

  useEffect(() => { void loadStatus(); }, [locale]);

  useEffect(() => {
    if (!ready || (!status && !statusFailed) || autoStartedRef.current) return;
    const plan = new URLSearchParams(window.location.search).get("plan");
    if (plan === "monthly" || plan === "term" || plan === "semester") {
      autoStartedRef.current = true;
      void startCheckout(plan);
    }
  }, [ready, status, statusFailed]);

  async function loadStatus() {
    const response = await fetch("/api/credits", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
    if (!response.ok) {
      // Returning silently left status null, which disabled every purchase
      // button behind a message saying everything was fine.
      setStatusFailed(true);
      return null;
    }
    setStatusFailed(false);
    const data = await response.json() as CreditStatus;
    setStatus(data);
    return data;
  }

  async function openPortal() {
    if (pending || portalPending) return;
    setPortalPending(true);
    setPortalMessage("");
    try {
      const response = await fetch("/api/billing/portal", { method: "POST", headers: { "X-Site-Locale": locale } });
      const data = await response.json() as { url?: string; error?: string };
      if (!response.ok || !data.url) throw new Error(data.error);
      window.location.assign(data.url);
    } catch (caught) {
      setPortalMessage(caught instanceof Error && caught.message ? caught.message : t.portalFailed);
      setPortalPending(false);
    }
  }

  // A missing credit snapshot is not a reason to block buying credits.
  const disabled = !ready || (!status && !statusFailed) || pending !== null || portalPending;
  const displayMessage = message || portalMessage || (statusFailed ? t.statusFailed : t.ready);

  function label(plan: BillingPlan, fallback: string) {
    return pending === plan ? t.opening : fallback;
  }

  return (
    <main className="billing-shell">
      <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" strategy="afterInteractive" onLoad={initializePaddle} onReady={initializePaddle} />
      <header className="billing-topbar"><Link className="brand" href={basePath || "/"}>Lecue</Link><Link href={`${basePath}/classroom`}>{t.classroom}</Link></header>
      <section className="billing-stage" aria-labelledby="billing-title">
        <header className="billing-heading"><h1 id="billing-title">{t.title}</h1><p>{t.description}</p></header>
        <section className="credit-summary" aria-live="polite"><span>{t.credits}</span><strong>{status ? status.credits.toLocaleString(locale === "en" ? "en-US" : "ko-KR") : "—"}</strong><small>{t.unit}</small>{status?.nextExpiry && <time>{t.expiry} · {new Date(status.nextExpiry).toLocaleDateString(locale === "en" ? "en-US" : "ko-KR")}</time>}</section>
        <div className="billing-plans">
          <article className="billing-plan billing-plan-featured"><span>{t.monthly}</span><h2>{t.monthlyPrice}</h2><strong>{t.monthlyCredits}</strong><p>{t.trial}</p><button type="button" onClick={() => void startCheckout("monthly")} disabled={disabled}>{label("monthly", status?.trialUsed ? t.subscribe : t.startTrial)}</button></article>
          <article className="billing-plan"><span>{t.term}</span><h2>{t.termPrice}</h2><strong>{t.termCredits}</strong><p>{t.oneTime}</p><button type="button" onClick={() => void startCheckout("term")} disabled={disabled}>{label("term", t.buyTerm)}</button></article>
          <article className="billing-plan"><span>{t.semester}</span><h2>{t.semesterPrice}</h2><strong>{t.semesterCredits}</strong><p>{t.oneTime}</p><button type="button" onClick={() => void startCheckout("semester")} disabled={disabled}>{label("semester", t.buy)}</button></article>
        </div>
        <p className="billing-methods">{t.methods}</p>
        <p className="billing-message" role="status">{(pending || portalPending) && <i className="auth-spinner auth-spinner-dark" aria-hidden="true" />}{displayMessage}</p>
        {status?.subscriptionStatus && <button className="billing-manage" type="button" onClick={() => void openPortal()} disabled={pending !== null || portalPending}>{t.manage}</button>}
      </section>
      <footer className="billing-footer"><Link href={`${basePath}/terms`}>{locale === "en" ? "Terms" : "이용약관"}</Link><Link href={`${basePath}/privacy`}>{locale === "en" ? "Privacy" : "개인정보처리방침"}</Link><span>Paddle secure checkout</span></footer>
    </main>
  );
}
