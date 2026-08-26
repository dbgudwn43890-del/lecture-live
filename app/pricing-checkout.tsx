"use client";

import Script from "next/script";
import { createContext, useContext, type ReactNode } from "react";

import { usePaddleCheckout, type BillingPlan } from "./lib/use-paddle-checkout";

type Locale = "ko" | "en";

type Ctx = {
  ready: boolean;
  pending: BillingPlan | "webhook" | null;
  message: string;
  startCheckout: (plan: BillingPlan) => void;
};

const PricingContext = createContext<Ctx | null>(null);

export function PricingCheckoutProvider({ locale, basePath, children }: { locale: Locale; basePath: string; children: ReactNode }) {
  const { ready, pending, message, initializePaddle, startCheckout } = usePaddleCheckout(locale, () => {
    window.location.assign(`${basePath}/classroom?payment=success`);
  });

  return (
    <PricingContext.Provider value={{ ready, pending, message, startCheckout }}>
      {/* lazyOnload: only buyers need Paddle, but every marketing visitor was
          downloading and executing it against hydration. */}
      <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" strategy="lazyOnload" onLoad={initializePaddle} onReady={initializePaddle} />
      {children}
    </PricingContext.Provider>
  );
}

/** Surfaces checkout errors, which the plan buttons alone silently swallowed. */
export function PricingCheckoutMessage({ className }: { className?: string }) {
  const ctx = useContext(PricingContext);
  if (!ctx?.message) return null;
  return <p className={className} role="status">{ctx.message}</p>;
}

export function PricingCheckoutButton({
  plan, label, pendingLabel, className,
}: { plan: BillingPlan; label: ReactNode; pendingLabel: string; className?: string }) {
  const ctx = useContext(PricingContext);
  if (!ctx) return null;
  return (
    <button type="button" className={className} onClick={() => ctx.startCheckout(plan)} disabled={!ctx.ready || ctx.pending !== null}>
      {ctx.pending === plan ? pendingLabel : label}
    </button>
  );
}
