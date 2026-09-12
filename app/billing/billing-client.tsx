"use client";
import Link from "next/link";
import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, LockKeyhole, X } from "lucide-react";
import { PLANS, PURCHASE_PLANS, STARTER_CREDITS, STARTER_DAYS, isPurchasePlan, type PurchasePlan } from "../lib/plans";
import { usePaddleCheckout } from "../lib/use-paddle-checkout";
import { localizedPrices, pricePreviewItems, monthlyPriceComparison, type LocalizedPrices, type PaddlePriceIds } from "../lib/paddle-pricing";
import { languageSwitchUrl } from "../lib/site-locale";
import SiteLanguageMenu from "../site-language-menu";
import CreditUsage, { type UsageStatus } from "../credit-usage";
import { checkoutReturnPath } from "../lib/payment-return";
import { getPlanLabel } from "../lib/plan-label";
import styles from "./billing.module.css";

type Account = { paddle_customer_id: string | null; subscription_status: string | null; next_billed_at: string | null; scheduled_cancel_at: string | null } | null;
type CreditBalance = UsageStatus;
const CARD_PLANS = PURCHASE_PLANS.filter(plan => plan !== "topup");

/** 플랜별 문구. 숫자는 PLANS에서 오고 여기는 말만 붙인다. */
const COPY: Record<PurchasePlan, { tagline: [string, string]; period: [string, string]; renewal: [string, string] }> = {
  monthly: {
    tagline: ["매달 필요한 만큼", "Month by month"],
    period: ["매월 결제", "Billed monthly"],
    renewal: ["매월 자동 갱신 · 언제든 다음 결제 해지", "Renews monthly · cancel the next payment anytime"],
  },
  semester: {
    tagline: ["한 학기를 여유롭게", "A semester at your pace"],
    period: ["", ""],
    renewal: ["첫 지급은 바로 · 이후 매월 지급\n자동 결제 없음", "First refill now, then monthly\nNo automatic renewal"],
  },
  halfyear: {
    tagline: ["6개월을 꾸준하게", "Keep going for six months"],
    period: ["", ""],
    renewal: ["첫 지급은 바로 · 이후 매월 지급\n자동 결제 없음", "First refill now, then monthly\nNo automatic renewal"],
  },
  annual: {
    tagline: ["1년 내내, 방학까지", "The whole year, breaks included"],
    period: ["", ""],
    renewal: ["첫 지급은 바로 · 이후 매월 지급\n자동 결제 없음", "First refill now, then monthly\nNo automatic renewal"],
  },
  topup: {
    tagline: ["부족할 때 채우기", "When you run short"],
    period: ["한 번만 결제", "One payment"],
    renewal: ["바로 지급 · 월 지급 일정은 그대로", "Available now · monthly refills stay on schedule"],
  },
};

export default function BillingClient({ locale, region, signedIn, email, mode, available, priceIds, account }: { locale: "ko" | "en"; region: "kr" | "global"; signedIn: boolean; email?: string; mode: "sandbox" | "live" | "disabled"; available: PurchasePlan[]; priceIds: PaddlePriceIds; account: Account }) {
  const en = locale === "en", base = en ? "/en" : "";
  const t = (ko: string, english: string) => en ? english : ko;
  const won = (value: number) => en ? new Intl.NumberFormat("en-US", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(value) : `${value.toLocaleString("ko-KR")}원`;
  const [credit, setCredit] = useState<CreditBalance | null>(null);
  const [portalPending, setPortalPending] = useState(false), [portalMessage, setPortalMessage] = useState("");
  const [selected, setSelected] = useState<PurchasePlan | null>(null);
  const [pageSearch, setPageSearch] = useState("");
  const topupDialog = useRef<HTMLDialogElement>(null);
  function openTopup() {
    if (!signedIn) return;
    setSelected("topup");
    topupDialog.current?.showModal();
  }
  async function loadCredits() {
    if (!signedIn) return;
    try { const response = await fetch("/api/credits", { cache: "no-store" }); if (response.ok) setCredit(await response.json()); } catch { /* No invented zero balance. */ }
  }
  const checkout = usePaddleCheckout(locale, () => location.replace(checkoutReturnPath(locale)), { enabled: mode !== "disabled", signedIn, email: account?.paddle_customer_id ? undefined : email });
  const [prices, setPrices] = useState<LocalizedPrices>({});
  const [priceState, setPriceState] = useState<"loading" | "ready" | "error">("loading");
  const priceRequest = useRef(0);
  const loadPrices = useCallback(async () => {
    if (!window.Paddle || !checkout.ready || mode === "disabled") return;
    const request = ++priceRequest.current;
    setPriceState("loading");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        window.Paddle.PricePreview({ items: pricePreviewItems(priceIds) }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PRICE_TIMEOUT")), 12000); }),
      ]);
      const nextPrices = localizedPrices(result, priceIds);
      if (request === priceRequest.current) { setPrices(nextPrices); setPriceState("ready"); }
    } catch {
      if (request === priceRequest.current) { setPrices({}); setPriceState("error"); }
    } finally { clearTimeout(timer); }
  }, [checkout.ready, mode, priceIds]);
  useEffect(() => { void loadPrices(); return () => { priceRequest.current++; }; }, [loadPrices]);
  useEffect(() => {
    void loadCredits();
    setPageSearch(location.search);
    const plan = new URLSearchParams(location.search).get("plan");
    if (isPurchasePlan(plan)) {
      setSelected(plan);
      if (plan === "topup" && signedIn) topupDialog.current?.showModal();
    }
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
  const planEnd = credit?.scheduledEndsAt ? new Date(credit.scheduledEndsAt) : null;
  const activePlan = credit?.scheduledPlanCode && planEnd && Number.isFinite(planEnd.valueOf()) && planEnd.valueOf() > Date.now() ? credit.scheduledPlanCode : null;
  const planBlocked = Boolean(activePlan) || subscribed;
  const topupPrice = prices.topup;
  const topupAvailable = mode !== "disabled" && available.includes("topup");
  const topupReady = topupAvailable && priceState === "ready" && Boolean(topupPrice) && checkout.ready && !checkout.pending && !checkout.unconfirmed;
  return <div className={styles.page}>
    {mode !== "disabled" && <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" onReady={checkout.initializePaddle} onError={() => { checkout.unavailable(); setPriceState("error"); }} />}
    <header className={styles.header}><Link className={`${styles.logo} brand-lockup`} href={base || "/"}><span className="lecue-symbol" aria-hidden="true" />Lecue</Link><nav aria-label={t("페이지 이동", "Navigation")}><SiteLanguageMenu locale={locale} region={region} href={`${base}/billing${pageSearch}`} /><Link href={signedIn ? languageSwitchUrl(`${base}/classroom`, locale) : base || "/"} prefetch={false}><ArrowLeft size={15} />{signedIn ? t("내 강의실", "My classroom") : t("홈으로", "Home")}</Link></nav></header>
    <main className={styles.main}>
      <div className={styles.heading}>
        <p>{t("수업을 이어가는 만큼, 매월 채워지는 크레딧", "Fresh credits for every month of classes")}</p>
        <h1>{t("내 수업에 맞는 플랜", "Choose your pace.")}</h1>
        <p>{t("기능은 모두 같아요. 함께할 기간과 결제 방식만 고르세요.", "Every feature is included. Choose how long to stay and how to pay.")}</p>
      </div>
      {mode === "sandbox" && <p className={styles.notice}>{t("테스트 결제 · 실제 금액은 청구되지 않습니다.", "Test checkout · No real money will be charged.")}</p>}
      {mode === "disabled" && <p className={styles.notice}>{t("유료 플랜은 준비 중입니다. 지금은 카드 없이 무료로 체험하세요.", "Paid plans are coming soon. Try Lecue free without a card.")}</p>}
      {mode !== "disabled" && <div className={styles.priceStatus} role="status" aria-live="polite">{priceState === "error" || !checkout.ready && checkout.message ? <>{t("가격을 불러오지 못했어요.", "We couldn't load your prices.")} <button onClick={() => checkout.ready ? void loadPrices() : location.reload()}>{t("다시 불러오기", "Try again")}</button></> : priceState === "loading" ? t("현지 가격을 확인하고 있어요…", "Checking your local prices…") : t("세금을 반영한 예상 금액입니다. 최종 금액은 결제 주소에 따라 확인됩니다.", "Estimated totals include tax. Your billing address determines the final amount.")}</div>}
      {signedIn && <div className={styles.account}>
        <CreditUsage status={credit} locale={locale} onRefresh={() => void loadCredits()} />
        <div className={styles.accountActions}><button onClick={openTopup} aria-haspopup="dialog">{t("크레딧 추가", "Add credits")}<ArrowRight size={15} /></button>{account?.paddle_customer_id && <button onClick={openPortal} disabled={portalPending}>{portalPending ? t("여는 중…", "Opening…") : t("결제·구독 관리", "Manage billing")}<ArrowRight size={15} /></button>}</div>
      </div>}
      {!signedIn && selected === "topup" && <p className={styles.topupLogin}>{t("크레딧 추가는 로그인 후 이용할 수 있어요.", "Sign in to add credits.")} <Link href={languageSwitchUrl(`${base}/login?next=${encodeURIComponent(`${base}/billing?plan=topup`)}`, locale)} prefetch={false}>{t("로그인", "Sign in")}<ArrowRight size={15}/></Link></p>}
      {signedIn && planBlocked && <p className={styles.activePlan}>{t("새 플랜은 현재 이용 기간이 끝난 뒤 선택할 수 있어요. 부족한 크레딧은 추가 구매하세요.", "Choose a new plan after your current period ends. Add credits if you need more now.")}</p>}
      {account?.scheduled_cancel_at && <p className={styles.detail}>{t("구독 해지가 예약되어 다음 결제는 청구되지 않습니다.", "Cancellation is scheduled. You will not be charged at renewal.")}</p>}
      {account?.subscription_status === "past_due" && <p className={styles.notice}>{t("Monthly 결제가 완료되지 않았습니다. 결제 관리에서 결제수단을 확인해 주세요.", "Your Monthly payment is overdue. Check your payment method in billing management.")}</p>}
      <p className={styles.creditValidity}>{t("매월 2,400 크레딧이 새로 지급돼요. 쓰지 않은 월 크레딧은 다음 달로 이월되지 않습니다.", "Get 2,400 fresh credits each month. Unused monthly credits do not roll over.")}</p>
      <div className={styles.plans}>
        {CARD_PLANS.map((key) => {
          const plan = PLANS[key], copy = COPY[key];
          const local = prices[key];
          const ready = mode !== "disabled" && available.includes(key);
          const canChoose = ready && priceState === "ready" && Boolean(local);
          const comparison = monthlyPriceComparison(local, prices.monthly, plan.installmentCount, locale);
          const allowance = plan.monthlyCredits ?? plan.credits;
          const blocked = planBlocked;
          return <article key={key} className={`${styles.plan} ${key === "semester" ? styles.featured : ""} ${selected === key ? styles.selected : ""}`}>
            <div className={styles.planName}><h2>{getPlanLabel(key, locale)}</h2><span>{t(...copy.tagline)}</span>{key === "semester" && <b className={styles.badge}>{t("추천", "Recommended")}</b>}</div>
            <div className={styles.allowance}><strong>{plan.months}<span>{t("개월", plan.months === 1 ? "month" : "months")}</span></strong><p>{t(`매월 ${allowance.toLocaleString()} 크레딧 · 강의 기록 ${allowance / 60}시간`, `${allowance.toLocaleString()} credits per month · ${allowance / 60} recording hours`)}</p></div>
            <div className={styles.priceBlock}>
              {comparison && <p className={styles.comparison}><s>{comparison.formattedTotal}</s></p>}
              <p className={styles.price} aria-busy={mode !== "disabled" && priceState === "loading"}>{local?.formattedTotal ?? (mode === "disabled" ? en ? `$${plan.usd}` : won(plan.krw) : "—")}{local && <small className={styles.currency}>{local.currency}</small>}{copy.period[0] && <span>{t(...copy.period)}</span>}</p>
              {comparison && <p className={styles.savings}>{t(`${comparison.percent}% 절약`, `Save ${comparison.percent}%`)}</p>}
            </div>
            <p className={styles.renewal}>{t(...copy.renewal)}</p>
            {!signedIn
              ? <Link className={styles.choose} href={languageSwitchUrl(`${base}/login?next=${encodeURIComponent(`${base}/billing?plan=${key}`)}`, locale)} prefetch={false}>{t("로그인하고 선택", "Sign in to choose")}<ArrowRight size={18} /></Link>
              : <button className={styles.choose} onClick={() => { setSelected(key); void checkout.startCheckout(key); }} disabled={!canChoose || !checkout.ready || Boolean(checkout.pending) || checkout.unconfirmed || blocked}>
                  {checkout.pending === key ? t("결제창 여는 중…", "Opening checkout…") : blocked ? activePlan === key || !activePlan && key === "monthly" ? t("이용 중인 플랜", "Current plan") : t("이용 기간 종료 후 선택", "Choose after this period") : !ready ? t("준비 중", "Coming soon") : priceState !== "ready" ? t("가격 확인 중", "Checking price") : t(`${plan.name} 선택`, `Choose ${plan.name}`)}<ArrowRight size={18} />
                </button>}
          </article>;
        })}
      </div>
      {CARD_PLANS.some(key => monthlyPriceComparison(prices[key], prices.monthly, PLANS[key].installmentCount, locale)) && <p className={styles.comparisonNote}>{t("취소선 가격은 Monthly로 같은 기간 이용할 때의 합계입니다.", "Crossed-out prices show the cost of Monthly over the same period.")}</p>}
      <div className={styles.feedback} role="status" aria-live="polite">{checkout.message || portalMessage}{checkout.unconfirmed && !checkout.pending && <button onClick={() => void checkout.checkPayment()}>{t("결제 상태 다시 확인", "Check payment status")}</button>}</div>
      <p className={styles.paymentNote}><LockKeyhole size={15}/>{t("Paddle의 안전한 결제창에서 결제합니다. 지원 결제수단·현지 통화·세금·최종 금액은 결제창에서 확인하세요.", "Pay securely with Paddle. Available payment methods, local currency, tax and the final total appear at checkout.")}</p>
      <section className={styles.included}><h2>{t("어떤 플랜이든, 수업의 처음부터 끝까지.", "Everything you need, in every plan.")}</h2><ul>{[t("영어·한국어 등 다양한 언어로 강의 기록", "Lecture transcription in English and more"),t("강의 맥락을 읽는 질문과 답변", "Questions answered with your lecture’s context"),t("강의 자료 연결과 복습 노트", "Course materials and review notes")].map(item=><li key={item}><Check size={17}/>{item}</li>)}</ul></section>
      <section className={styles.trial}><div><h2>{t("먼저 한 수업에서 써보세요.", "Try it in your next class.")}</h2><p>{t(`새 계정으로 강의실을 처음 열면 ${STARTER_CREDITS} 크레딧을 무료로 받아요. 지급일부터 ${STARTER_DAYS}일 동안 사용하며, 카드 등록과 자동 결제는 없습니다.`, `Open your first classroom with a new account to receive ${STARTER_CREDITS} free credits, valid for ${STARTER_DAYS} days from issue. No card or automatic renewal.`)}</p></div><Link href={languageSwitchUrl(signedIn ? `${base}/classroom` : `${base}/login`, locale)} prefetch={false}>{t("무료로 시작", "Start free")}<ArrowRight size={17}/></Link></section>
      <section className={styles.faq} aria-label={t("결제 안내", "Billing questions")}>
        <details><summary>{t("크레딧은 어떻게 사용하나요?", "How do credits work?")}</summary><p>{t("강의 기록은 1분 단위로 계산하며, 각 1분 구간이 시작될 때 1 크레딧을 사용해요. 예를 들어 30초 기록은 1 크레딧, 1분 10초 기록은 2 크레딧입니다. 질문·답변에는 크레딧을 추가로 사용하지 않고, 크레딧을 모두 써도 기존 기록은 읽을 수 있어요.", "Recording uses one credit for each minute started. For example, a 30-second recording uses 1 credit, and a 1-minute-10-second recording uses 2. Questions and answers use no extra credits. Your saved lectures remain readable when credits run out.")}</p></details>
        <details><summary>{t("매월 언제 지급되나요?", "When do monthly credits arrive?")}</summary><p>{t(`첫 ${PLANS.monthly.monthlyCredits.toLocaleString()} 크레딧은 결제 확인 후 바로 지급해요. 월간은 유료 갱신마다, 학기권·6개월권·연간권은 첫 결제일을 기준으로 매월 한 번씩 총 4회·6회·12회 지급합니다.`, `Your first ${PLANS.monthly.monthlyCredits.toLocaleString()} credits arrive once payment is confirmed. Monthly refills with each paid renewal. Semester, Half-year and Annual refill monthly from your original payment date, for 4, 6 and 12 refills in total.`)}</p><p>{t("지급일은 UTC 기준이며, 같은 날짜가 없는 달에는 말일에 지급해요. 주 단위로 초기화되지 않습니다.", "Refill dates use UTC. If a month has no matching date, the refill falls on its last day. Credits do not reset weekly.")}</p></details>
        <details><summary>{t("쓰지 않은 월 크레딧은 어떻게 되나요?", "What happens to unused monthly credits?")}</summary><p>{t("월 크레딧은 다음 월 지급일에 만료되고, 새 2,400 크레딧으로 시작해요. 다음 달로 이월되지 않으며, 마지막 달의 남은 수량도 결제한 이용 기간이 끝나면 만료됩니다.", "Monthly credits expire at the next monthly boundary, when a fresh 2,400 credits begin. They do not roll over. Your final month's remaining credits expire when the paid period ends.")}</p><p>{t("새 결제나 추가 구매로 기존 크레딧의 기한이 늘어나지 않아요. 기본 크레딧과 추가 크레딧의 사용 기한을 각각 확인할 수 있어요.", "A new payment or top-up does not extend existing credits. Plan credits and extra credits show their own expiry dates.")}</p></details>
        <details><summary>{t("해지하거나 이용 기간이 끝나면요?", "What happens when I cancel or my plan ends?")}</summary><p>{t("월간은 결제·구독 관리에서 다음 자동 결제를 해지할 수 있어요. 이번 달 크레딧은 현재 결제 기간이 끝날 때까지 사용합니다.", "Cancel the next Monthly payment in Manage billing. This month's credits remain usable until the current paid period ends.")}</p><p>{t("학기권·6개월권·연간권은 각각 4개월·6개월·12개월 후 종료되며 자동으로 다시 결제하지 않아요. 새 플랜은 현재 이용 기간이 끝난 뒤 선택할 수 있습니다. 별도로 추가한 크레딧은 플랜 종료와 관계없이 구매일부터 12개월 동안 사용할 수 있어요.", "Semester, Half-year and Annual end after 4, 6 and 12 months without another charge. Choose a new plan once the current period ends. Separately purchased extra credits remain usable for 12 months from purchase, even after a plan ends.")}</p></details>
        <details><summary>{t("다음 지급 전에 크레딧이 부족하면요?", "What if I run out before my next refill?")}</summary><p>{t(`로그인 후 잔액 옆 ‘크레딧 추가’에서 ${PLANS.topup.credits.toLocaleString()} 크레딧을 바로 추가할 수 있어요. 구매일부터 12개월 동안 사용하며, 플랜의 지급일·이용 기간이나 기존 잔액의 기한은 바뀌지 않습니다.`, `After signing in, choose Add credits beside your balance to get ${PLANS.topup.credits.toLocaleString()} extra credits immediately. They last 12 months from purchase and do not change your plan's refill dates, paid period or existing credit expiry dates.`)}</p></details>
        <details><summary>{t("기존에 구매한 플랜도 바뀌나요?", "Does this change a plan I already bought?")}</summary><p>{t("기존 구매는 구매 당시의 지급 수량과 일정이 그대로 적용돼요. 이미 한 번에 받은 크레딧을 월별 지급으로 나누거나 줄이지 않습니다.", "Existing purchases keep their original credit amounts and schedules. Credits already issued upfront will not be reduced or split into monthly refills.")}</p></details>
        <details><summary>{t("결제 후 크레딧이 바로 보이지 않으면요?", "What if my credits do not appear?")}</summary><p>{t("결제 확인이 잠시 지연될 수 있습니다. 다시 결제하지 말고 결제 상태를 확인해 주세요. 계속 지연되면 계정 이메일과 결제 번호를 support@lecue.app으로 보내주세요.", "Confirmation may take a moment. Check payment status before trying another payment. If it takes longer, email support@lecue.app with your account email and transaction number.")}</p></details>
        <details><summary>{t("환불은 어떻게 요청하나요?", "How do I request a refund?")}</summary><p>{t("결제 내역 또는 support@lecue.app을 통해 요청할 수 있습니다. 사용분과 해당 지역의 소비자 권리를 반영하며 자세한 조건은 환불 정책을 확인해 주세요.", "Request a refund through your payment receipt or support@lecue.app. Usage and applicable consumer rights are taken into account; see the refund policy for details.")} <Link href={`${base}/refund-policy`}>{t("환불 정책", "Refund policy")}</Link></p></details>
      </section>
    </main>
    {signedIn && <dialog ref={topupDialog} className={styles.topupDialog} aria-labelledby="topup-title" aria-describedby="topup-description">
      <div className={styles.dialogHeader}><h2 id="topup-title">{t("크레딧 추가", "Add credits")}</h2><button type="button" className={styles.dialogClose} aria-label={t("닫기", "Close")} onClick={() => topupDialog.current?.close()} autoFocus><X size={20}/></button></div>
      <p id="topup-description" className={styles.dialogDescription}>{t("이번 달에 조금 더 필요할 때 추가하세요.", "A little extra when you need it this month.")}</p>
      <div className={styles.topupAmount}><strong>{PLANS.topup.credits.toLocaleString()} <span>{t("크레딧", "credits")}</span></strong><p>{t("결제 확인 후 바로 지급 · 구매일부터 12개월", "Available once payment is confirmed · valid for 12 months from purchase")}</p></div>
      <p className={styles.price} aria-busy={mode !== "disabled" && priceState === "loading"}>{topupPrice?.formattedTotal ?? (mode === "disabled" ? en ? `$${PLANS.topup.usd}` : won(PLANS.topup.krw) : "—")}{topupPrice && <small className={styles.currency}>{topupPrice.currency}</small>}<span>{t(...COPY.topup.period)}</span></p>
      <p className={styles.dialogPolicy}>{t("월 크레딧의 만료일과 별개예요. 플랜을 갱신하거나 기존 잔액의 사용 기한을 연장하지 않습니다.", "These have their own expiry date. They do not renew a plan or extend existing credits.")}</p>
      {mode !== "disabled" && priceState === "error" && <p className={styles.dialogPriceError}>{t("가격을 불러오지 못했어요.", "We couldn't load your price.")} <button onClick={() => checkout.ready ? void loadPrices() : location.reload()}>{t("다시 불러오기", "Try again")}</button></p>}
      <button type="button" className={styles.choose} disabled={!topupReady} onClick={() => { topupDialog.current?.close(); void checkout.startCheckout("topup"); }}>{checkout.pending === "topup" ? t("결제창 여는 중…", "Opening checkout…") : !topupAvailable ? t("준비 중", "Coming soon") : priceState !== "ready" ? t("가격 확인 중", "Checking price") : t("1,000 크레딧 구매", "Buy 1,000 credits")}<ArrowRight size={18}/></button>
      <p className={styles.dialogPayment}>{t("현지 통화·세금·최종 금액은 Paddle 결제창에서 확인하세요.", "Confirm local currency, tax and the final total in Paddle checkout.")}</p>
    </dialog>}
    <footer className={styles.footer}><span>© 2026 Lecue</span><nav><Link href={`${base}/terms`}>{t("이용약관", "Terms")}</Link><Link href={`${base}/privacy`}>{t("개인정보처리방침", "Privacy")}</Link><Link href={`${base}/refund-policy`}>{t("환불 정책", "Refunds")}</Link><a href="mailto:support@lecue.app">{t("문의", "Support")}</a></nav></footer>
  </div>;
}
