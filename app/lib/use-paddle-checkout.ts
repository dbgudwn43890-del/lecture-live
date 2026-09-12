"use client";
import { useEffect, useRef, useState } from "react";
import type { PurchasePlan } from "./plans";
import type { PricePreviewResult } from "./paddle-pricing";
import { checkoutReturnPath, isPaymentTransaction } from "./payment-return";
type Locale = "ko" | "en";
type PaddleEvent = { name?: string; data?: { transaction_id?: string } };
type Callback = (event: PaddleEvent) => void;
type Settings = { displayMode: "overlay"; variant: "one-page"; theme: "light" | "dark"; locale: Locale; showAddDiscounts: false; allowLogout: false; successUrl: string };
type PaddleApi = {
  Initialized?: boolean;
  Environment: { set(environment: "sandbox"): void };
  Initialize(options: { token: string; eventCallback: Callback; checkout: { settings: Settings } }): void;
  Update(options: { eventCallback: Callback }): void;
  PricePreview(options: { items: { priceId: string; quantity: number }[] }): Promise<PricePreviewResult>;
  Checkout: { open(options: { transactionId: string; customer?: { email: string }; settings: Settings }): void; close(): void };
};
declare global { interface Window { Paddle?: PaddleApi } }

export function usePaddleCheckout(locale: Locale, onGranted: () => void, { enabled, signedIn, email }: { enabled: boolean; signedIn: boolean; email?: string }) {
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<PurchasePlan | "sync" | null>(null);
  const [message, setMessage] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const active = useRef(true), busy = useRef(false), polling = useRef(false);
  const transaction = useRef<string | null>(null);
  const en = locale === "en";
  const settings = (id: unknown = new URLSearchParams(location.search).get("_ptxn")): Settings => ({ displayMode: "overlay", variant: "one-page", locale, theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light", showAddDiscounts: false, allowLogout: false, successUrl: new URL(checkoutReturnPath(locale, id), location.origin).href });
  function rememberPayment(id: string | null) {
    try { if (id) sessionStorage.setItem("lecue-pending-payment", id); else sessionStorage.removeItem("lecue-pending-payment"); } catch { /* Checkout also works when browser storage is unavailable. */ }
  }
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const unavailable = () => { setReady(false); setMessage(en ? "Checkout could not load. Reload the page or check your connection." : "결제창을 불러오지 못했습니다. 연결을 확인하거나 페이지를 새로고침해 주세요."); };

  async function checkPayment() {
    if (!signedIn || !transaction.current || polling.current) return;
    const transactionId = transaction.current;
    polling.current = true; busy.current = true;
    setPending("sync"); setUnconfirmed(true);
    setMessage(en ? "Confirming payment and adding your credits…" : "결제를 확인하고 credits를 반영하고 있어요…");
    try {
      for (let i = 0; i < 20 && active.current; i++) {
        try {
          const response = await fetch(`/api/billing/status?transaction=${encodeURIComponent(transactionId)}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
          if ([401, 403, 404].includes(response.status)) {
            rememberPayment(null); transaction.current = null; setUnconfirmed(false);
            setMessage(en ? "Sign in with the account used for this purchase to view your credits." : "구매할 때 사용한 계정으로 로그인하면 credits를 확인할 수 있어요.");
            return;
          }
          const data = response.ok ? await response.json() : null;
          if (!active.current) return;
          if (data?.granted === true) {
            rememberPayment(null); setUnconfirmed(false); setPending(null);
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
    if (!enabled || !window.Paddle) return;
    const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    if (!token) return unavailable();
    const eventCallback: Callback = event => {
      if (!active.current) return;
      if (event.name === "checkout.completed") {
        const id = event.data?.transaction_id;
        if (isPaymentTransaction(id)) rememberPayment(id);
        // Do not make the buyer wait on Paddle's success screen or the webhook.
        // Navigation grants nothing; the classroom checks the owned order.
        try { window.Paddle?.Checkout.close(); } catch { /* The success URL still returns to Lecue if the frame is already gone. */ }
        location.replace(checkoutReturnPath(locale, id));
      } else if (["checkout.closed", "checkout.error"].includes(event.name ?? "") && !polling.current) {
        busy.current = false; setPending(null);
        if (event.name === "checkout.error") setMessage(en ? "Checkout could not continue. Check your connection and try again." : "결제를 진행하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
      }
    };
    try {
      const checkout = { settings: settings() };
      if (window.Paddle.Initialized) window.Paddle.Update({ eventCallback });
      else {
        if (process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT === "sandbox") window.Paddle.Environment.set("sandbox");
        window.Paddle.Initialize({ token, eventCallback, checkout });
      }
      setReady(true);
    } catch { unavailable(); }
  }

  useEffect(() => {
    if (!enabled) return;
    try {
      const saved = signedIn ? sessionStorage.getItem("lecue-pending-payment") : null;
      if (saved && /^txn_[a-z0-9]+$/.test(saved)) { transaction.current = saved; setUnconfirmed(true); }
    } catch { /* Optional recovery state. */ }
    if (window.Paddle) initializePaddle();
  }, [locale, enabled, signedIn]);

  async function startCheckout(plan: PurchasePlan) {
    if (!enabled || !signedIn || busy.current || unconfirmed || !ready || !window.Paddle) return;
    busy.current = true; setPending(plan); setMessage("");
    try {
      const response = await fetch("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json", "X-Site-Locale": locale }, body: JSON.stringify({ plan }), signal: AbortSignal.timeout(30000) });
      const data = await response.json();
      if (!response.ok || !data.transactionId) throw new Error(data.error);
      if (!active.current) return;
      transaction.current = data.transactionId;
      window.Paddle.Checkout.open({ transactionId: data.transactionId, ...(email ? { customer: { email } } : {}), settings: settings(data.transactionId) });
    } catch (error) {
      busy.current = false;
      if (active.current) { setPending(null); setMessage(error instanceof Error && error.message ? error.message : en ? "Could not open checkout. Try again." : "결제창을 열지 못했습니다. 다시 시도해 주세요."); }
    }
  }
  return { ready, pending, message, unconfirmed, initializePaddle, startCheckout, checkPayment, unavailable };
}
