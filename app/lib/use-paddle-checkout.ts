"use client";
import { useEffect, useRef, useState } from "react";
import type { PurchasePlan } from "./plans";
type Locale = "ko" | "en";
type PaddleEvent = { name?: string; data?: { transaction_id?: string } };
type Callback = (event: PaddleEvent) => void;
type Settings = { displayMode: "overlay"; variant: "one-page"; theme: "light" | "dark"; locale: Locale; showAddDiscounts: false; allowLogout: false };
type PaddleApi = {
  Initialized?: boolean;
  Environment: { set(environment: "sandbox"): void };
  Initialize(options: { token: string; eventCallback: Callback }): void;
  Update(options: { eventCallback: Callback }): void;
  Checkout: { open(options: { transactionId: string; settings: Settings }): void };
};
declare global { interface Window { Paddle?: PaddleApi } }

export function usePaddleCheckout(locale: Locale, onGranted: () => void) {
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<PurchasePlan | "sync" | null>(null);
  const [message, setMessage] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const active = useRef(true), busy = useRef(false), polling = useRef(false);
  const transaction = useRef<string | null>(null);
  const en = locale === "en";
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const unavailable = () => { setReady(false); setMessage(en ? "Checkout could not load. Reload the page or check your connection." : "결제창을 불러오지 못했습니다. 연결을 확인하거나 페이지를 새로고침해 주세요."); };

  async function checkPayment() {
    if (!transaction.current || polling.current) return;
    polling.current = true; busy.current = true;
    setPending("sync"); setUnconfirmed(true);
    setMessage(en ? "Confirming payment and adding your credits…" : "결제를 확인하고 credits를 반영하고 있어요…");
    try {
      for (let i = 0; i < 20 && active.current; i++) {
        try {
          const response = await fetch(`/api/billing/status?transaction=${encodeURIComponent(transaction.current)}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
          const data = response.ok ? await response.json() : null;
          if (!active.current) return;
          if (data?.granted === true) {
            sessionStorage.removeItem("lecue-pending-payment"); setUnconfirmed(false); setPending(null);
            setMessage(en ? "Payment confirmed. Your credits are ready." : "결제가 확인됐어요. credits를 사용할 수 있습니다.");
            onGranted(); return;
          }
        } catch { /* A failed read is not proof of payment failure. */ }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (active.current) setMessage(en ? "Confirmation is taking longer. Do not pay again. Check payment status below or contact support." : "결제 확인이 지연되고 있어요. 다시 결제하지 마세요. 아래에서 상태를 확인하거나 문의해 주세요.");
    } finally { polling.current = false; busy.current = false; if (active.current) setPending(null); }
  }

  function initializePaddle() {
    if (!window.Paddle) return;
    const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    if (!token) return unavailable();
    const eventCallback: Callback = event => {
      if (!active.current) return;
      if (event.name === "checkout.completed" && transaction.current && event.data?.transaction_id === transaction.current) {
        sessionStorage.setItem("lecue-pending-payment", transaction.current); void checkPayment();
      } else if (["checkout.closed", "checkout.error"].includes(event.name ?? "") && !polling.current) {
        busy.current = false; setPending(null);
        if (event.name === "checkout.error") setMessage(en ? "Checkout could not continue. Check your connection and try again." : "결제를 진행하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
      }
    };
    try {
      if (window.Paddle.Initialized) window.Paddle.Update({ eventCallback });
      else {
        if (process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT === "sandbox") window.Paddle.Environment.set("sandbox");
        window.Paddle.Initialize({ token, eventCallback });
      }
      setReady(true);
    } catch { unavailable(); }
  }

  useEffect(() => {
    const saved = sessionStorage.getItem("lecue-pending-payment");
    if (saved && /^txn_[a-z0-9]+$/.test(saved)) { transaction.current = saved; setUnconfirmed(true); }
    if (window.Paddle) initializePaddle();
  }, [locale]);

  async function startCheckout(plan: PurchasePlan) {
    if (busy.current || unconfirmed || !ready || !window.Paddle) return;
    busy.current = true; setPending(plan); setMessage("");
    try {
      const response = await fetch("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json", "X-Site-Locale": locale }, body: JSON.stringify({ plan }), signal: AbortSignal.timeout(30000) });
      const data = await response.json();
      if (!response.ok || !data.transactionId) throw new Error(data.error);
      if (!active.current) return;
      transaction.current = data.transactionId;
      window.Paddle.Checkout.open({ transactionId: data.transactionId, settings: { displayMode: "overlay", variant: "one-page", locale, theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light", showAddDiscounts: false, allowLogout: false } });
    } catch (error) {
      busy.current = false;
      if (active.current) { setPending(null); setMessage(error instanceof Error && error.message ? error.message : en ? "Could not open checkout. Try again." : "결제창을 열지 못했습니다. 다시 시도해 주세요."); }
    }
  }
  return { ready, pending, message, unconfirmed, initializePaddle, startCheckout, checkPayment, unavailable };
}
