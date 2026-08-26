"use client";

import { useRef, useState } from "react";

export type BillingPlan = "monthly" | "term" | "semester";
type Locale = "ko" | "en";
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
    notConfigured: "결제창 설정이 아직 완료되지 않았습니다.",
    opening: "안전한 결제창을 여는 중입니다…",
    processing: "결제 완료를 확인하고 크레딧을 반영하는 중입니다…",
    syncing: "결제는 완료됐습니다. 크레딧 반영 중이니 잠시 후 새로고침해 주세요.",
    openFailed: "결제창을 열지 못했습니다. 다시 시도해 주세요.",
  },
  en: {
    notConfigured: "Checkout has not been configured yet.",
    opening: "Opening secure checkout…",
    processing: "Confirming payment and adding your credits…",
    syncing: "Payment completed. Credits are still syncing; refresh in a moment.",
    openFailed: "Could not open checkout. Try again.",
  },
} as const;

export function usePaddleCheckout(locale: Locale, onCreditsGranted: () => void) {
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<BillingPlan | "webhook" | null>(null);
  const [message, setMessage] = useState("");
  const initializedRef = useRef(false);
  const baselineRef = useRef<{ credits: number; grantAt: string | null }>({ credits: 0, grantAt: null });
  const t = copy[locale];

  function initializePaddle() {
    if (initializedRef.current || !window.Paddle) return;
    const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    if (!token) {
      setMessage(t.notConfigured);
      return;
    }
    if (process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT === "sandbox") window.Paddle.Environment.set("sandbox");
    window.Paddle.Initialize({
      token,
      checkout: { settings: { displayMode: "overlay", variant: "one-page", theme: "light", locale } },
      eventCallback(event) {
        if (event.name === "checkout.completed") return void waitForCredits();
        // Closing the overlay leaves no other signal, so without this the
        // plan buttons stayed disabled on "opening checkout…" until a reload.
        if (event.name === "checkout.closed" || event.name === "checkout.error") {
          setPending(null);
          setMessage(event.name === "checkout.error" ? t.openFailed : "");
        }
      },
    });
    initializedRef.current = true;
    setReady(true);
  }

  async function waitForCredits() {
    setPending("webhook");
    setMessage(t.processing);
    const baseline = baselineRef.current;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      const response = await fetch("/api/credits", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
      if (response.ok) {
        const current = await response.json() as { credits?: number; latestGrantAt?: string | null };
        if ((current.credits ?? 0) > baseline.credits || current.latestGrantAt !== baseline.grantAt) {
          setPending(null);
          onCreditsGranted();
          return;
        }
      }
    }
    // Refresh before telling the user it is still syncing, otherwise the
    // credit figure above the message contradicts it.
    onCreditsGranted();
    setPending(null);
    setMessage(t.syncing);
  }

  async function startCheckout(plan: BillingPlan) {
    if (!window.Paddle || !ready || pending) return;
    setPending(plan);
    setMessage(t.opening);
    try {
      const statusResponse = await fetch("/api/credits", { headers: { "X-Site-Locale": locale }, cache: "no-store" });
      const status = statusResponse.ok ? await statusResponse.json() as { credits?: number; latestGrantAt?: string | null } : {};
      baselineRef.current = { credits: status.credits ?? 0, grantAt: status.latestGrantAt ?? null };

      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ plan }),
      });
      const data = await response.json() as { transactionId?: string; error?: string };
      if (!response.ok || !data.transactionId) throw new Error(data.error);
      window.Paddle!.Checkout.open({ transactionId: data.transactionId });
      setMessage("");
    } catch (caught) {
      setMessage(caught instanceof Error && caught.message ? caught.message : t.openFailed);
      setPending(null);
    }
  }

  return { ready, pending, message, initializePaddle, startCheckout };
}
