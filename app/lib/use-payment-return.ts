"use client";

import { useEffect, useRef } from "react";
import { isPaymentTransaction, PENDING_PAYMENT_KEY } from "./payment-return";

/** Let the buyer use the classroom while the signed webhook finishes. */
export function usePaymentReturn(locale: "ko" | "en", refreshCredits: () => Promise<boolean>, notify: (message: string) => void) {
  const callbacks = useRef({ refreshCredits, notify });
  callbacks.current = { refreshCredits, notify };
  useEffect(() => {
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(PENDING_PAYMENT_KEY); } catch { /* The URL also carries the return ID. */ }
    const fromUrl = new URLSearchParams(location.search).get("billing_tx");
    const transactionId = isPaymentTransaction(fromUrl) ? fromUrl : saved;
    if (!isPaymentTransaction(transactionId)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let running = false;
    let finished = false;
    function clearReturn() {
      finished = true;
      try { if (sessionStorage.getItem(PENDING_PAYMENT_KEY) === transactionId) sessionStorage.removeItem(PENDING_PAYMENT_KEY); } catch { /* Optional storage. */ }
      const url = new URL(location.href);
      if (url.searchParams.get("billing_tx") === transactionId) {
        url.searchParams.delete("billing_tx");
        history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    }
    async function check() {
      if (controller.signal.aborted || running || finished) return;
      clearTimeout(timer);
      running = true;
      attempts++;
      try {
        const response = await fetch(`/api/billing/status?transaction=${encodeURIComponent(transactionId!)}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        if (controller.signal.aborted) return;
        if ([401, 403, 404].includes(response.status)) { clearReturn(); return; }
        const result = response.ok ? await response.json() : null;
        if (controller.signal.aborted) return;
        if (result?.granted === true) {
          const refreshed = await callbacks.current.refreshCredits();
          if (refreshed) {
            if (!controller.signal.aborted) clearReturn();
            return;
          }
        }
      } catch { /* A delayed read must never be presented as a failed payment. */ }
      finally { running = false; }
      if (controller.signal.aborted || finished) return;
      if (attempts < 20) timer = setTimeout(check, 2000);
      else callbacks.current.notify(locale === "en"
        ? "Your credits are still being updated. Please don't pay again. Contact support@lecue.app if they don't appear."
        : "credits 반영을 확인하고 있어요. 다시 결제하지 마세요. 계속 보이지 않으면 support@lecue.app으로 알려주세요.");
    }
    function resume() { if (!finished && !running) { attempts = 0; void check(); } }
    void check();
    window.addEventListener("focus", resume);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener("focus", resume); };
  }, [locale]);
}
