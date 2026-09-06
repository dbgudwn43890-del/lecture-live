"use client";
import Link from "next/link";
import Script from "next/script";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CreditCard, LockKeyhole } from "lucide-react";
import { PLANS, PURCHASE_PLANS, STARTER_CREDITS, STARTER_DAYS, discountPercent, isPurchasePlan, type PurchasePlan } from "../lib/plans";
import { usePaddleCheckout } from "../lib/use-paddle-checkout";
import styles from "./billing.module.css";

type Account = { paddle_customer_id: string | null; subscription_status: string | null; next_billed_at: string | null; scheduled_cancel_at: string | null } | null;

/** 플랜별 문구. 숫자는 PLANS에서 오고 여기는 말만 붙인다. */
const COPY: Record<PurchasePlan, { tagline: [string, string]; period: [string, string]; renewal: [string, string]; expiry: [string, string] }> = {
  monthly: {
    tagline: ["매달 필요한 만큼", "Month by month"],
    period: ["/ 월", "/ month"],
    renewal: ["매월 자동 결제 · 언제든 다음 갱신 해지", "Renews monthly · cancel the next renewal anytime"],
    expiry: ["각 결제 주기 말에 미사용 credits가 만료됩니다.", "Unused credits expire at the end of each billing period."],
  },
  semester: {
    tagline: ["한 학기를 여유롭게", "A semester at your pace"],
    period: ["/ 4개월", "/ 4 months"],
    renewal: ["한 번만 결제 · 자동 갱신 없음", "One payment · no automatic renewal"],
    expiry: ["결제일부터 4개월간 자유롭게 나눠 사용하세요.", "Use your credits across any classes within four months."],
  },
  annual: {
    tagline: ["1년 내내, 방학까지", "The whole year, breaks included"],
    period: ["/ 12개월", "/ 12 months"],
    renewal: ["한 번만 결제 · 자동 갱신 없음", "One payment · no automatic renewal"],
    expiry: ["결제일부터 12개월간 유효 · 계절학기와 스터디까지.", "Valid for twelve months — summer terms and study groups included."],
  },
  topup: {
    tagline: ["부족할 때 채우기", "When you run short"],
    period: ["/ 1회", "/ one time"],
    renewal: ["플랜과 함께 사용 · 필요할 때마다 추가 구매", "Stacks with any plan · buy again whenever you need"],
    expiry: ["구매일부터 12개월간 유효합니다.", "Valid for twelve months from purchase."],
  },
};

export default function BillingClient({ locale, signedIn, mode, available, account }: { locale: "ko" | "en"; signedIn: boolean; mode: "sandbox" | "live" | "disabled"; available: PurchasePlan[]; account: Account }) {
  const en = locale === "en", base = en ? "/en" : "";
  const t = (ko: string, english: string) => en ? english : ko;
  const won = (value: number) => `${value.toLocaleString()}원`;
  const [credit, setCredit] = useState<{ credits: number; nextExpiry: string | null } | null>(null);
  const [portalPending, setPortalPending] = useState(false), [portalMessage, setPortalMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [selected, setSelected] = useState<PurchasePlan | null>(null);
  async function loadCredits() {
    if (!signedIn) return;
    try { const response = await fetch("/api/credits", { cache: "no-store" }); if (response.ok) setCredit(await response.json()); } catch { /* No invented zero balance. */ }
  }
  const checkout = usePaddleCheckout(locale, () => { setSuccess(true); void loadCredits(); });
  useEffect(() => {
    void loadCredits();
    const plan = new URLSearchParams(location.search).get("plan");
    if (isPurchasePlan(plan)) setSelected(plan);
  }, []);
  async function openPortal() {
    if (portalPending) return;
    setPortalPending(true); setPortalMessage("");
    try {
      const response = await fetch("/api/billing/portal", { method: "POST", headers: { "X-Site-Locale": locale }, signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      if (!response.ok || !data.url) throw new Error(data.error);
      location.assign(data.url);
    } catch { setPortalPending(false); setPortalMessage(t("결제 관리 화면을 열지 못했습니다. 다시 시도해 주세요.", "Could not open billing management. Try again.")); }
  }
  const subscribed = ["active", "trialing", "past_due", "paused"].includes(account?.subscription_status ?? "");
  const launchDiscount = Math.max(...PURCHASE_PLANS.map(discountPercent));
  return <div className={styles.page}>
    {signedIn && mode !== "disabled" && <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" onReady={checkout.initializePaddle} onError={checkout.unavailable} />}
    <header className={styles.header}><Link className={styles.logo} href={base || "/"}>Lecue<span>.</span></Link><nav aria-label={t("페이지 이동", "Navigation")}><a href={`${base}/billing?lang=${en ? "ko" : "en"}`}>{en ? "Korean" : "English"}</a><Link href={signedIn ? `${base}/classroom` : base || "/"}><ArrowLeft size={15} />{signedIn ? t("내 강의실", "My classroom") : t("홈으로", "Home")}</Link></nav></header>
    <main className={styles.main}>
      <div className={styles.heading}>
        <p>{t(`출시 기념 최대 ${launchDiscount}% 할인 · 부가세 포함`, `Launch offer · up to ${launchDiscount}% off · tax included`)}</p>
        <h1>{t("내 수업에 맞는 플랜", "Choose your pace.")}</h1>
        <p>{t("기능은 모두 같아요. 필요한 시간과 결제 방식만 고르세요.", "Every feature is included. Choose the time and payment schedule that fit.")}</p>
      </div>
      {mode === "sandbox" && <p className={styles.notice}>{t("테스트 결제 · 실제 금액은 청구되지 않습니다.", "Test checkout · No real money will be charged.")}</p>}
      {mode === "disabled" && <p className={styles.notice}>{t("유료 플랜은 준비 중입니다. 지금은 카드 없이 무료로 체험하세요.", "Paid plans are coming soon. Try Lecue free without a card.")}</p>}
      {signedIn && <div className={styles.account}><div><CreditCard size={18} /><span>{credit ? `${credit.credits.toLocaleString()} credits` : "— credits"}</span>{credit?.nextExpiry && <small>{t("가장 가까운 만료일", "Next expiry")} {new Date(credit.nextExpiry).toLocaleDateString(en ? "en-US" : "ko-KR")}</small>}</div>{account?.paddle_customer_id && <button onClick={openPortal} disabled={portalPending}>{portalPending ? t("여는 중…", "Opening…") : t("결제·구독 관리", "Manage billing")}<ArrowRight size={15} /></button>}</div>}
      {account?.scheduled_cancel_at && <p className={styles.detail}>{t("구독 해지가 예약되어 다음 결제는 청구되지 않습니다.", "Cancellation is scheduled. You will not be charged at renewal.")}</p>}
      {account?.subscription_status === "past_due" && <p className={styles.notice}>{t("Monthly 결제가 완료되지 않았습니다. 결제 관리에서 결제수단을 확인해 주세요.", "Your Monthly payment is overdue. Check your payment method in billing management.")}</p>}
      <div className={styles.plans}>
        {PURCHASE_PLANS.map((key) => {
          const plan = PLANS[key], copy = COPY[key];
          const ready = mode !== "disabled" && available.includes(key);
          const hours = plan.credits / 60;
          const perMonth = plan.recurring || key === "topup" ? null : Math.round(plan.krw / plan.months / 100) * 100;
          const blocked = key === "monthly" && subscribed;
          return <article key={key} className={`${styles.plan} ${key === "semester" ? styles.featured : ""} ${selected === key ? styles.selected : ""}`}>
            <div className={styles.planName}><h2>{plan.name}</h2><span>{t(...copy.tagline)}</span>{key === "semester" && <b className={styles.badge}>{t("가장 많이 선택", "Most popular")}</b>}{key === "annual" && <b className={styles.badge}>{t("최저 단가", "Best value")}</b>}</div>
            <div className={styles.priceBlock}>
              <p className={styles.compare}><span>{t("프로모션 종료 후 예정가", "Planned post-promotion price")}</span><del>{en ? `$${plan.listUsd}` : won(plan.listKrw)}</del><b>-{discountPercent(key)}%</b></p>
              <p className={styles.price}>{en ? `$${plan.usd}` : won(plan.krw)}<span>{t(...copy.period)}</span></p>
              {perMonth && <p className={styles.perMonth}>{en ? `≈ $${(plan.usd / plan.months).toFixed(2)} / month` : `월 ${won(perMonth)} 꼴`}</p>}
            </div>
            <div className={styles.allowance}><strong>{plan.credits.toLocaleString()} <span>credits</span></strong><p>{plan.recurring ? t(`매월 ${hours}시간의 강의 기록`, `${hours} recording hours each month`) : t(`${Math.round(hours)}시간의 강의 기록 · 한 번에 지급`, `${Math.round(hours)} recording hours · available upfront`)}</p></div>
            <p className={styles.renewal}>{t(...copy.renewal)}</p>
            {!signedIn
              ? <Link className={styles.choose} href={`${base}/login?next=${encodeURIComponent(`${base}/billing?plan=${key}`)}`}>{t("로그인하고 선택", "Sign in to choose")}<ArrowRight size={18} /></Link>
              : <button className={styles.choose} onClick={() => { setSelected(key); void checkout.startCheckout(key); }} disabled={!ready || !checkout.ready || Boolean(checkout.pending) || checkout.unconfirmed || blocked}>
                  {checkout.pending === key ? t("결제창 여는 중…", "Opening checkout…") : blocked ? t("이용 중인 구독", "Current subscription") : !ready ? t("준비 중", "Coming soon") : t(`${plan.name} 선택`, `Choose ${plan.name}`)}<ArrowRight size={18} />
                </button>}
            <p className={styles.expiry}>{t(...copy.expiry)}</p>
          </article>;
        })}
      </div>
      <p className={styles.promoNote}>{t("취소선 가격은 프로모션 종료 후 적용할 예정인 가격입니다. 종료 일정과 최종 결제 금액은 결제 전에 안내합니다.", "Struck-through prices are planned post-promotion prices. The end date and final charge are shown before checkout.")}</p>
      <div className={styles.feedback} role="status" aria-live="polite">{checkout.message || portalMessage}{checkout.unconfirmed && !checkout.pending && <button onClick={() => void checkout.checkPayment()}>{t("결제 상태 다시 확인", "Check payment status")}</button>}{success && <Link href={`${base}/classroom`}>{t("강의실로 이동", "Go to classroom")}<ArrowRight size={16}/></Link>}</div>
      <p className={styles.paymentNote}><LockKeyhole size={15}/>{t("Paddle의 안전한 결제창에서 결제합니다. 지원 결제수단·현지 통화·세금·최종 금액은 결제창에서 확인하세요.", "Pay securely with Paddle. Available payment methods, local currency, tax and the final total appear at checkout.")}</p>
      <section className={styles.included}><h2>{t("어떤 플랜이든, 수업의 처음부터 끝까지.", "Everything you need, in every plan.")}</h2><ul>{[t("한국어·영어·혼용 강의 기록", "Korean, English and mixed-language transcription"),t("강의 맥락을 읽는 질문과 답변", "Questions answered with your lecture’s context"),t("강의 자료 연결과 복습 노트", "Course materials and review notes")].map(item=><li key={item}><Check size={17}/>{item}</li>)}</ul></section>
      <section className={styles.trial}><div><h2>{t("먼저 한 수업에서 써보세요.", "Try it in your next class.")}</h2><p>{t(`처음 가입하면 ${STARTER_CREDITS} credits. 카드 등록 없이 ${STARTER_DAYS}일 동안 사용하세요.`, `Start with ${STARTER_CREDITS} credits, valid for ${STARTER_DAYS} days. No card required.`)}</p></div><Link href={signedIn ? `${base}/classroom` : `${base}/login`}>{t("무료로 시작", "Start free")}<ArrowRight size={17}/></Link></section>
      <section className={styles.faq} aria-label={t("결제 안내", "Billing questions")}>
        <details><summary>{t("credits는 어떻게 사용하나요?", "How do credits work?")}</summary><p>{t("강의를 기록하는 1분에 1 credit을 사용합니다. 1분 미만도 1 credit이며 같은 구간을 중복 차감하지 않습니다. 질문·답변은 별도 차감 없이 이용할 수 있고, credits를 모두 써도 기존 기록은 읽을 수 있어요.", "One credit records one minute; a partial minute counts as one credit. The same recording minute is never charged twice. Questions and answers do not use extra credits. Your saved lectures remain readable when credits run out.")}</p></details>
        <details><summary>{t("credits가 부족하면요?", "What if I run out of credits?")}</summary><p>{t(`Top-up으로 ${PLANS.topup.credits.toLocaleString()} credits를 언제든 추가할 수 있고, 어떤 플랜과도 함께 씁니다. 여러 구매분이 있으면 만료가 빠른 것부터 차감돼요. 자주 부족하다면 Semester·Annual이 credit당 더 저렴합니다.`, `Add ${PLANS.topup.credits.toLocaleString()} credits with a Top-up at any time; it stacks with any plan. When you hold several purchases, the one expiring soonest is used first. If you run short often, Semester and Annual cost less per credit.`)}</p></details>
        <details><summary>{t("구독을 해지하거나 플랜을 바꿀 수 있나요?", "Can I cancel or switch?")}</summary><p>{t("Monthly는 결제·구독 관리에서 언제든 다음 갱신을 해지할 수 있고, 이미 결제한 credits는 원래 만료일까지 사용할 수 있어요. Semester·Annual·Top-up은 1회 결제라 해지할 것이 없고, 필요할 때 추가 구매하면 됩니다. Monthly는 중복 구독할 수 없습니다.", "Cancel the next Monthly renewal in Manage billing; paid credits remain valid until their original expiry. Semester, Annual and Top-up are one-time purchases — nothing to cancel, buy again when you need more. Only one Monthly subscription can be active.")}</p></details>
        <details><summary>{t("결제 후 credits가 바로 보이지 않으면요?", "What if my credits do not appear?")}</summary><p>{t("결제 확인이 잠시 지연될 수 있습니다. 다시 결제하지 말고 결제 상태를 확인해 주세요. 계속 지연되면 계정 이메일과 결제 번호를 support@lecue.app으로 보내주세요.", "Confirmation may take a moment. Check payment status before trying another payment. If it takes longer, email support@lecue.app with your account email and transaction number.")}</p></details>
        <details><summary>{t("환불은 어떻게 요청하나요?", "How do I request a refund?")}</summary><p>{t("결제 내역 또는 support@lecue.app을 통해 요청할 수 있습니다. 사용분과 해당 지역의 소비자 권리를 반영하며 자세한 조건은 환불 정책을 확인해 주세요.", "Request a refund through your payment receipt or support@lecue.app. Usage and applicable consumer rights are taken into account; see the refund policy for details.")} <Link href={`${base}/refund-policy`}>{t("환불 정책", "Refund policy")}</Link></p></details>
      </section>
    </main>
    <footer className={styles.footer}><span>© 2026 Lecue</span><nav><Link href={`${base}/terms`}>{t("이용약관", "Terms")}</Link><Link href={`${base}/privacy`}>{t("개인정보처리방침", "Privacy")}</Link><Link href={`${base}/refund-policy`}>{t("환불 정책", "Refunds")}</Link><a href="mailto:support@lecue.app">{t("문의", "Support")}</a></nav></footer>
  </div>;
}
