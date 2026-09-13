"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ANALYTICS_CONSENT, ANALYTICS_EVENTS, analyticsEnabled, safeAnalyticsLocation, type AnalyticsEvent } from "./lib/analytics-policy";
import { hasAnalyticsConsent } from "./lib/analytics-client";
import "./analytics-consent.css";

export default function AnalyticsConsent({ locale }: { locale: "en" | "ko" }) {
  const path = usePathname();
  const en = locale === "en";
  const [choice, setChoice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const pending = useRef<Array<{ event: AnalyticsEvent; location: string }>>([]);
  const signupCheck = useRef(false);
  const page = useRef("");

  function send(event: AnalyticsEvent) {
    try {
      if (!hasAnalyticsConsent()) return;
      const item = { event, location: safeAnalyticsLocation(window.location.href) };
      if (!ready.current) { if (pending.current.length < 20) pending.current.push(item); return; }
      frame.current?.contentWindow?.postMessage({ type: "lecue-measure", ...item }, window.location.origin);
    } catch { /* Optional measurement. */ }
  }

  function view() {
    if (page.current === path) return;
    page.current = path;
    send("page_view");
    if (["/", "/en", "/ko"].includes(path)) send("landing_view");
  }

  async function signup() {
    if (signupCheck.current || !hasAnalyticsConsent() || !ready.current) return;
    signupCheck.current = true;
    try {
      const response = await fetch("/api/analytics/signup", { method: "POST", signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      if (data.claimed === true && hasAnalyticsConsent()) send("sign_up");
    } catch { /* Login and product work regardless of this request. No ambiguous retry. */ }
    finally { signupCheck.current = false; }
  }

  useEffect(() => {
    // Local/preview traffic never reaches the production GA property.
    setEnabled(window.location.hostname === "www.lecue.app"
      && analyticsEnabled(process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID));
    function sync() {
      try {
        const saved = localStorage.getItem(ANALYTICS_CONSENT);
        const granted = hasAnalyticsConsent();
        setChoice(granted ? "granted" : saved === "denied" ? "denied" : null);
        if (!granted) {
          ready.current = false; pending.current = []; page.current = "";
          if (frame.current) frame.current.src = "about:blank";
        }
      } catch { setChoice(null); }
    }
    sync();
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow
        || event.data?.type !== "lecue-measure-ready" || !hasAnalyticsConsent()) return;
      ready.current = true;
      for (const item of pending.current.splice(0)) {
        frame.current?.contentWindow?.postMessage({ type: "lecue-measure", ...item }, window.location.origin);
      }
      void signup();
    };
    const product = (event: Event) => {
      const name = (event as CustomEvent).detail;
      if (name !== "sign_up" && ANALYTICS_EVENTS.includes(name)) send(name);
    };
    const click = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-analytics-signup="true"]')) send("signup_click");
    };
    window.addEventListener("storage", sync);
    let consentChannel: BroadcastChannel | null = null;
    try { consentChannel = new BroadcastChannel(ANALYTICS_CONSENT); } catch { /* Unsupported or blocked browser storage. */ }
    if (consentChannel) consentChannel.onmessage = sync;
    window.addEventListener("message", receive);
    window.addEventListener("lecue:analytics", product);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("storage", sync); window.removeEventListener("message", receive);
      consentChannel?.close();
      window.removeEventListener("lecue:analytics", product); document.removeEventListener("click", click, true);
    };
  }, []); // Listeners read current consent and refs, never an initial consent value.

  useEffect(() => {
    if (choice === "granted" && enabled) { view(); void signup(); }
  }, [path, choice, enabled]);

  function choose(granted: boolean) {
    if (!granted) {
      // Stop the whole Google document, including automatic engagement timers.
      if (frame.current) frame.current.src = "about:blank"; ready.current = false; pending.current = []; page.current = "";
    }
    try {
      const value = granted ? "granted" : "denied";
      document.cookie = `${ANALYTICS_CONSENT}=${value}; Path=/; Max-Age=15552000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
      try { localStorage.setItem(ANALYTICS_CONSENT, value); } catch {
        document.cookie = `${ANALYTICS_CONSENT}=denied; Path=/; Max-Age=15552000; SameSite=Lax`;
        granted = false;
      }
      if (!granted) {
        for (const cookie of document.cookie.split(";")) {
          const name = cookie.trim().split("=")[0];
          if (!/^(_ga|_gid|_gat|_gcl)(_|$)/.test(name)) continue;
          for (const domain of ["", location.hostname, ".lecue.app"]) {
            document.cookie = `${name}=; Max-Age=0; Path=/${domain ? `; Domain=${domain}` : ""}`;
          }
        }
      }
      setChoice(granted && hasAnalyticsConsent() ? "granted" : "denied");
      setOpen(false);
    } catch { setChoice("denied"); setOpen(false); }
    try { const channel = new BroadcastChannel(ANALYTICS_CONSENT); channel.postMessage("changed"); channel.close(); } catch { /* Storage events remain the fallback. */ }
  }

  return <>
    {choice === "granted" && enabled && <iframe ref={frame} src="/api/analytics/frame" title="Optional analytics" hidden referrerPolicy="no-referrer" />}
    {!(open || choice === null) && <button className="analytics-settings" type="button" onClick={() => setOpen(true)} aria-expanded={false} aria-controls="analytics-choice">{en ? "Cookie settings" : "쿠키 설정"}</button>}
    {(open || choice === null) && <section id="analytics-choice" className="analytics-choice" aria-label={en ? "Cookie settings" : "쿠키 설정"}>
      <div className="analytics-copy">
        <strong>{en ? "Cookies on Lecue" : "Lecue의 쿠키 사용"}</strong>
        <p>{en ? "Essential cookies keep you signed in. Optional cookies let Google Analytics and Google Ads measure visits, signups and feature use. Analytics is off until you allow it." : "로그인 유지에는 필수 쿠키를 사용해요. 선택 쿠키는 Google Analytics·Google Ads의 방문·가입·기능 사용 측정에 쓰이며, 허용하기 전까지 꺼져 있어요."}</p>
      </div>
      <div className="analytics-actions"><button type="button" onClick={() => choose(false)}>{choice === "granted" ? en ? "Withdraw consent" : "동의 철회" : en ? "Essential only" : "필수 쿠키만"}</button><button type="button" onClick={() => choose(true)}>{en ? "Allow analytics" : "분석 허용"}</button></div>
      <details className="analytics-details">
        <summary>{en ? "Cookie details" : "쿠키 사용 자세히 보기"}</summary>
        <p><strong>{en ? "Essential · always on" : "필수 · 항상 사용"}</strong><br />{en ? "Used for sign-in and your saved preferences. They work without analytics consent." : "로그인과 저장한 설정을 유지하며, 분석 동의 없이도 작동해요."}</p>
        <p><strong>{en ? `Analytics · ${choice === "granted" ? "on" : "off"}` : `선택 분석 · ${choice === "granted" ? "사용 중" : "꺼짐"}`}</strong><br />{en ? "Google Analytics and Google Ads use pseudonymous cookies and ad click IDs to measure visits, verified new signups and feature use. We do not send account details or lecture content, or use personalized ads or remarketing. Analytics cookies last up to 90 days; your choice is saved for up to 180 days." : "Google Analytics·Google Ads가 가명 쿠키와 광고 클릭 ID로 방문, 인증된 신규 가입, 기능 사용을 측정해요. 계정 정보·강의 내용은 보내지 않고 맞춤 광고·리마케팅에 사용하지 않아요. 분석 쿠키는 최대 90일, 동의 선택은 최대 180일 유지돼요."}</p>
        <p>{en ? "Separate from required terms and recording consent. Essential only gives you full access to Lecue. You can withdraw analytics consent anytime in Cookie settings." : "필수 약관·녹음 동의와 별개예요. 필수 쿠키만 선택해도 Lecue를 그대로 이용할 수 있으며, 언제든 쿠키 설정에서 분석 동의를 철회할 수 있어요."} <a href={en ? "/en/privacy" : "/privacy"}>{en ? "Privacy policy" : "개인정보처리방침"}</a></p>
      </details>
    </section>}
  </>;
}
