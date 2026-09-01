import Link from "next/link";

import styles from "./landing.module.css";
import { getPlanLabel } from "./lib/plan-label";
import type { BillingPlan } from "./lib/use-paddle-checkout";
import { PricingCheckoutButton, PricingCheckoutMessage, PricingCheckoutProvider } from "./pricing-checkout";
import ProfileMenu from "./profile-menu";

type Locale = "ko" | "en";

const content = {
  ko: {
    homeLabel: "Lecue 홈",
    navLabel: "주요 메뉴",
    nav: ["기능", "요금", "자주 묻는 질문"],
    signIn: "로그인",
    signUp: "회원가입",
    classroom: "내 강의실",
    openClassroom: "강의실 열기",
    open: "선택하기",
    language: "EN",
    heroLabel: "현장 강의를 위한 실시간 조교",
    heroTitle: ["놓친 설명을,", "수업이 끝나기 전에."],
    heroDescription: "Lecue는 현장 강의를 실시간으로 기록하고, 방금까지의 수업 흐름을 바탕으로 질문에 답하는 학습 서비스입니다. 답변을 읽는 동안에도 기록은 계속됩니다.",
    heroCta: "7일 무료로 시작하기",
    heroNote: "7일 무료 체험 · 180크레딧",
    demoTitle: "질문과 강의가 나란히 흐릅니다",
    featuresLabel: "무엇을 하는 서비스인가",
    featuresTitle: ["수업 중에 필요한 것만,", "군더더기 없이."],
    features: [
      ["실시간 스크립트", "마이크로 들어온 강의를 문단 단위로 정리해 화면에 이어 붙입니다. 질문하는 동안에도 멈추지 않습니다."],
      ["질문한 시점까지의 맥락", "답변은 그 수업에서 지금까지 나온 설명을 근거로 만듭니다. 아직 다루지 않은 내용을 앞질러 말하지 않습니다."],
      ["필요할 때만 웹 검색", "강의 내용만으로 충분한지 먼저 판단하고, 최신 정보나 외부 확인이 필요할 때만 검색합니다."],
      ["과목별 강의실", "수업 스크립트와 질문을 과목별로 모아 둡니다. 다음 수업의 답변이 지난 수업을 참고합니다."],
    ],
    stepsLabel: "쓰는 순서",
    stepsTitle: ["세 번 누르면", "수업 준비 끝."],
    steps: [
      ["수업 전", "강의실 만들기", "과목 이름으로 강의실을 하나 만듭니다. 그 과목의 수업과 질문이 여기에 쌓입니다."],
      ["수업 중", "기록 시작", "강의실에서 기록을 켜면 스크립트가 실시간으로 이어집니다. 한 수업은 최대 3시간입니다."],
      ["흐름이 끊길 때", "그 자리에서 질문", "놓친 부분을 물으면 지금까지의 강의 내용을 근거로 답합니다. 기록은 계속됩니다."],
    ],
    demoQuestionTitle: "강의에 질문하기",
    demoQuestionCount: "1개 질문",
    demoQuestion: "여기서 말하는 증권회사가 정확히 뭐야?",
    demoAssistant: "강의 조교 · AI",
    demoAnswer: "기업과 투자자를 연결하는 금융 중개 회사예요. 기업이 주식이나 채권으로 돈을 모으는 절차를 돕고, 투자자가 거래할 수 있는 창구를 제공합니다.",
    demoGrounding: "강의 내용만으로 답했습니다.",
    demoTranscriptTitle: "실시간 스크립트",
    demoTranscriptCount: "3개 문단",
    demoTranscript: [
      "증권은 재산상의 권리를 표시한 문서나 전자 기록입니다.",
      "주식은 회사의 일부를 소유할 권리이고, 채권은 빌려준 돈을 돌려받을 권리입니다.",
      "증권회사는 기업이 이런 증권을 발행하도록 돕고 투자자가 거래할 수 있게 연결합니다.",
    ],
    roomsTitle: ["수업이 끝나도,", "질문한 맥락은 남게."],
    roomsDescription: "과목별 강의실에 수업 스크립트와 질문을 모아 둡니다. 새 수업에서 질문하면 같은 강의실의 지난 설명도 필요한 만큼 참고합니다.",
    roomsCta: "내 강의실로 이동",
    roomsHeader: "최근 강의",
    roomsComing: "강의실별 맥락 저장",
    rooms: [
      ["오늘", "경제학개론 · 증권시장", "1시간 18분 · 7개 질문"],
      ["8월 20일", "재무관리 · 채권의 가격", "52분 · 4개 질문"],
      ["8월 18일", "경영학원론 · 기업의 구조", "1시간 05분 · 9개 질문"],
    ],
    pricingLabel: "기간 한정 40% 프로모션 · 부가세 포함",
    pricingTitle: ["수업 일정에 맞는", "이용 기간을 고르세요."],
    pricingNoCard: "카카오페이·네이버페이·국내 카드",
    pricingIncluded: "기록·질문·강의실 맥락 포함",
    plans: [
      { name: "무료 체험", time: "7일", price: "무료", unit: "180크레딧", detail: "계정당 한 번", billingPlan: "monthly" },
      { name: "월간", time: "1개월", compareLabel: "프로모션 종료 후 예정가", comparePrice: "16,500원", price: "9,900원", priceNote: "/월", unit: "4,200크레딧 · 약 70시간", detail: "40% 프로모션", billingPlan: "monthly" },
      { name: "집중 학기", time: "4개월", compareLabel: "프로모션 종료 후 예정가", comparePrice: "56,700원", price: "34,000원", priceNote: "/4개월", unit: "16,800크레딧 · 약 280시간", detail: "40% 프로모션", featured: true, billingPlan: "term" },
      { name: "한 학기", time: "6개월", compareLabel: "프로모션 종료 후 예정가", comparePrice: "70,000원", price: "42,000원", priceNote: "/6개월", unit: "25,200크레딧 · 약 420시간", detail: "40% 프로모션", billingPlan: "semester" },
    ],
    featured: "가장 많이 선택",
    pricingFootnote: "취소선 가격은 프로모션 종료 후 적용할 예정인 가격입니다. 종료 일정과 최종 결제 금액은 결제 전에 안내합니다.",
    faqTitle: "자주 묻는 질문",
    faqs: [
      ["온라인 강의용 서비스인가요?", "아니요. 교실, 학원, 세미나처럼 같은 공간에서 듣는 현장 강의를 우선해 만들고 있습니다."],
      ["질문하는 동안 강의 기록이 멈추나요?", "멈추지 않습니다. 답변을 만드는 동안에도 마이크 음성과 스크립트는 계속 이어집니다."],
      ["모든 질문에 웹 검색을 사용하나요?", "아닙니다. 강의 내용만으로 충분한지 모델이 판단하고, 최신 정보나 외부 확인이 필요할 때만 검색합니다."],
      ["무료 체험에도 모든 기능을 쓸 수 있나요?", "네. 7일 동안 180크레딧으로 강의 기록, 질문, 강의실 맥락과 필요한 웹 검색을 모두 이용할 수 있습니다."],
      ["지난 수업도 답변에 반영되나요?", "같은 강의실에 저장한 이전 수업 중 질문과 관련된 부분만 찾아 보조 맥락으로 사용합니다. 다른 강의실의 내용은 섞지 않습니다."],
      ["제 OpenAI·Claude·Gemini 키를 쓸 수 있나요?", "네. 현재 탭에서 한 번만 쓰거나 계정에 암호화해 저장할 수 있습니다. 해당 공급자의 모델 비용은 본인 계정에 별도로 청구됩니다."],
      ["Google 로그인 정보는 어디에 사용하나요?", "Google에서 받은 이름, 이메일 주소와 프로필 사진은 Lecue 계정을 만들고 로그인 상태를 유지하는 데만 사용합니다. Gmail, Google Drive, 캘린더 등의 다른 Google 데이터에는 접근하지 않습니다."],
      ["강의를 녹음해도 되나요?", "강의자와 기관의 녹음 정책을 먼저 확인하고, 녹음이 허용된 환경에서만 사용해야 합니다."],
    ],
    finalTitle: ["다음 설명은,", "놓치지 않게."],
    finalCta: "첫 강의실 열기",
    checkoutOpening: "결제창 여는 중…",
    footerDescription: "현장 강의를 따라가며 바로 이해하는 실시간 조교",
    privacy: "개인정보처리방침",
    terms: "이용약관",
    refund: "환불 정책",
    support: "dbgudwn43890@gmail.com",
    recordingNotice: "강의자와 기관의 녹음 정책을 확인한 뒤 사용하세요.",
  },
  en: {
    homeLabel: "Lecue home",
    navLabel: "Main navigation",
    nav: ["Features", "Pricing", "FAQ"],
    signIn: "Sign in",
    signUp: "Sign up",
    classroom: "My classrooms",
    openClassroom: "Open classroom",
    open: "Choose plan",
    language: "한국어",
    heroLabel: "A live assistant for in-person lectures",
    heroTitle: ["Catch the explanation", "before class moves on."],
    heroDescription: "Lecue is a learning service that transcribes in-person lectures in real time and answers from everything said up to the moment you ask. Recording continues while you read the answer.",
    heroCta: "Start free",
    heroNote: "7-day free trial · 180 credits",
    demoTitle: "Questions and the lecture move side by side",
    featuresLabel: "What Lecue does",
    featuresTitle: ["Only what a lecture needs,", "and nothing else."],
    features: [
      ["Live transcript", "Speech from your microphone is written out paragraph by paragraph as the lecture runs. It does not pause while you ask."],
      ["Context up to your question", "Answers are built from what the lecture has covered so far. Lecue does not run ahead of the class."],
      ["Web search only when needed", "The model first decides whether the lecture is enough, and searches only for current information or outside verification."],
      ["A classroom per subject", "Transcripts and questions stay grouped by subject, so the next lecture can draw on the last one."],
    ],
    stepsLabel: "How it works",
    stepsTitle: ["Three taps", "and class is set."],
    steps: [
      ["Before class", "Open a classroom", "Create one classroom named after the subject. Its lectures and questions collect there."],
      ["During class", "Start recording", "Turn recording on and the transcript follows the lecture live. One lecture can run up to 3 hours."],
      ["When you lose the thread", "Ask right there", "Ask what you missed and the answer comes from the lecture so far. Recording keeps going."],
    ],
    demoQuestionTitle: "Ask about the lecture",
    demoQuestionCount: "1 question",
    demoQuestion: "What exactly does a brokerage firm do here?",
    demoAssistant: "Lecture assistant · AI",
    demoAnswer: "It connects companies that need money with investors. It helps a company raise money through new shares or bonds and gives investors a route to trade them.",
    demoGrounding: "Answered from the lecture alone.",
    demoTranscriptTitle: "Live transcript",
    demoTranscriptCount: "3 paragraphs",
    demoTranscript: [
      "A security is a document or electronic record representing a financial right.",
      "A share is ownership in a company. A bond is the right to be repaid money you lent.",
      "A brokerage helps companies issue securities and connects investors to the market where they trade.",
    ],
    roomsTitle: ["Class may end.", "The context should not."],
    roomsDescription: "Keep each subject's transcripts and questions in one classroom. New questions can draw on relevant explanations from earlier lectures in that same classroom.",
    roomsCta: "Go to my classrooms",
    roomsHeader: "Recent lectures",
    roomsComing: "Context saved by classroom",
    rooms: [
      ["Today", "Introduction to Economics · Securities", "1 hr 18 min · 7 questions"],
      ["Aug 20", "Corporate Finance · Bond Pricing", "52 min · 4 questions"],
      ["Aug 18", "Business Fundamentals · Company Structure", "1 hr 05 min · 9 questions"],
    ],
    pricingLabel: "Limited 40% promotion · local taxes may apply",
    pricingTitle: ["Choose a term", "that fits your schedule."],
    pricingNoCard: "Cards, Apple Pay, Google Pay, PayPal, and local options",
    pricingIncluded: "Transcription, questions, and classroom context included",
    plans: [
      { name: "Free trial", time: "7 days", price: "Free", unit: "180 credits", detail: "Once per account", billingPlan: "monthly" },
      { name: "Monthly", time: "1 month", compareLabel: "Planned post-promotion price", comparePrice: "$13.29", price: "$7.99", priceNote: "/month", unit: "4,200 credits · about 70 hours", detail: "40% promotion", billingPlan: "monthly" },
      { name: "Focused term", time: "4 months", compareLabel: "Planned post-promotion price", comparePrice: "$43.29", price: "$25.99", priceNote: "/4 months", unit: "16,800 credits · about 280 hours", detail: "40% promotion", featured: true, billingPlan: "term" },
      { name: "Semester", time: "6 months", compareLabel: "Planned post-promotion price", comparePrice: "$54.99", price: "$32.99", priceNote: "/6 months", unit: "25,200 credits · about 420 hours", detail: "40% promotion", billingPlan: "semester" },
    ],
    featured: "Most selected",
    pricingFootnote: "Struck-through prices are planned post-promotion prices. The end date and final charge are shown before checkout.",
    faqTitle: "Common questions",
    faqs: [
      ["Is this for online courses?", "No. Lecue is designed first for classrooms, seminars, workshops, and other lectures you attend in person."],
      ["Does recording stop while I ask?", "No. The microphone and transcript continue while an answer is being prepared."],
      ["Does every answer use web search?", "No. The model decides whether the lecture is enough and searches only when current information or outside verification is needed."],
      ["What can I use during the free trial?", "Use 180 credits during seven days for transcription, questions, classroom context, and needed web search."],
      ["Can answers use earlier lectures?", "Yes. Lecue retrieves only relevant excerpts from earlier lectures in the same classroom as supporting context. It never mixes in another classroom."],
      ["Can I use my own OpenAI, Claude, or Gemini key?", "Yes. Use it once in the current tab or save it encrypted to your account. That provider bills its own model charges separately."],
      ["How does Lecue use my Google sign-in data?", "Lecue uses your Google name, email address, and profile photo only to create your account and keep you signed in. It does not access Gmail, Google Drive, Calendar, or other Google data."],
      ["May I record any lecture?", "Check the lecturer's, institution's, and local recording rules first. Use Lecue only where recording is permitted."],
    ],
    finalTitle: ["Stay with the next explanation", "from start to finish."],
    finalCta: "Open my first classroom",
    checkoutOpening: "Opening checkout…",
    footerDescription: "A live assistant that helps you follow and understand in-person lectures",
    privacy: "Privacy Policy",
    terms: "Terms of Service",
    refund: "Refund Policy",
    support: "dbgudwn43890@gmail.com",
    recordingNotice: "Check the lecturer's and institution's recording rules before use.",
  },
} as const;

type Profile = { displayName: string; email: string; avatarUrl: string | null };
type LandingCreditStatus = { credits: number; planCode: string | null; trialUsed?: boolean };

export default function LandingPage({
  locale, isAuthenticated = false, profile, creditStatus,
}: { locale: Locale; isAuthenticated?: boolean; profile?: Profile | null; creditStatus?: LandingCreditStatus | null }) {
  const copy = content[locale];
  const base = locale === "en" ? "/en" : "";
  const classroomPath = `${base}/classroom`;

  return (
    <main className={styles.page} id="top">
      <header className={styles.header}>
        <Link className={styles.brand} href={base || "/"} aria-label={copy.homeLabel}>Lecue</Link>
        <nav className={styles.nav} aria-label={copy.navLabel}>
          <a href="#features">{copy.nav[0]}</a>
          <a href="#pricing">{copy.nav[1]}</a>
          <a href="#faq">{copy.nav[2]}</a>
        </nav>
        <div className={styles.headerActions}>
          {/* ?lang= tells the proxy to remember the choice; without it the IP
              guess re-renders "/" in English and the toggle appears to do nothing. */}
          <Link className={styles.languageLink} href={locale === "en" ? "/?lang=ko" : "/en?lang=en"}>{copy.language}</Link>
          {isAuthenticated ? (
            <>
              <ProfileMenu
                locale={locale}
                basePath={base}
                classroomPath={classroomPath}
                profile={profile ?? null}
                planLabel={getPlanLabel(creditStatus?.planCode, locale)}
                credits={creditStatus?.credits ?? null}
              />
              <Link className={styles.headerCta} href={classroomPath}>{copy.classroom}</Link>
            </>
          ) : (
            <>
              <Link className={styles.loginLink} href={`${base}/login`}>{copy.signIn}</Link>
              <Link className={styles.headerCta} href={`${base}/login?mode=signup`}>{copy.signUp}</Link>
            </>
          )}
        </div>
      </header>

      <section className={styles.hero} aria-labelledby={`hero-title-${locale}`}>
        <div className={styles.heroCopy}>
          <p className={styles.heroLabel}>{copy.heroLabel}</p>
          <h1 id={`hero-title-${locale}`}>{copy.heroTitle[0]}<br />{copy.heroTitle[1]}</h1>
          <p className={styles.heroDescription}>{copy.heroDescription}</p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryCta} href={isAuthenticated ? classroomPath : `${base}/billing?plan=monthly`}>{isAuthenticated ? copy.openClassroom : copy.heroCta}<span aria-hidden>→</span></Link>
          </div>
          <p className={styles.heroNote}>{copy.heroNote}</p>
        </div>

        <div className={`${styles.productFrame} ${styles.heroProductFrame}`} id="product" aria-label={copy.demoTitle}>
          <div className={styles.productTopbar}><b>Lecue</b><span>{locale === "en" ? "Introduction to Economics" : "경제학개론 · 증권시장"}</span><em><i />{locale === "en" ? "Recording" : "기록 중"}&nbsp;&nbsp;32:18</em></div>
          <div className={styles.productPanes}>
            <section className={styles.questionPane} aria-label={copy.demoQuestionTitle}>
              <header><h3>{copy.demoQuestionTitle}</h3><span>{copy.demoQuestionCount}</span></header>
              <div className={styles.demoMessages}><div className={styles.userQuestion}>{copy.demoQuestion}</div><div className={styles.demoAnswer}><span>{copy.demoAssistant}</span><p>{copy.demoAnswer}</p><small>{copy.demoGrounding}</small></div></div>
              <div className={styles.demoInput}>{locale === "en" ? "Ask about this lecture" : "강의 내용에서 궁금한 점을 물어보세요"}<span>↑</span></div>
            </section>
            <section className={styles.transcriptPane} aria-label={copy.demoTranscriptTitle}>
              <header><h3>{copy.demoTranscriptTitle}</h3><span>{copy.demoTranscriptCount}</span></header>
              <div className={styles.demoTranscript}>{copy.demoTranscript.map((line, index) => <p className={index === 2 ? styles.currentTranscript : undefined} key={line}>{line}</p>)}</div>
            </section>
          </div>
        </div>
      </section>

      <section className={styles.features} id="features" aria-labelledby={`features-title-${locale}`}>
        <header className={`${styles.featuresIntro} ${styles.reveal}`}>
          <p>{copy.featuresLabel}</p>
          <h2 id={`features-title-${locale}`}>{copy.featuresTitle[0]}<br />{copy.featuresTitle[1]}</h2>
        </header>
        <div className={`${styles.featureGrid} ${styles.reveal}`}>
          {copy.features.map(([title, detail]) => <article key={title}><h3>{title}</h3><p>{detail}</p></article>)}
        </div>
      </section>

      <section className={styles.steps} id="steps" aria-labelledby={`steps-title-${locale}`}>
        <header className={`${styles.stepsIntro} ${styles.reveal}`}>
          <p>{copy.stepsLabel}</p>
          <h2 id={`steps-title-${locale}`}>{copy.stepsTitle[0]}<br />{copy.stepsTitle[1]}</h2>
        </header>
        <ol className={`${styles.stepList} ${styles.reveal}`}>
          {copy.steps.map(([when, title, detail]) => <li key={title}><span>{when}</span><h3>{title}</h3><p>{detail}</p></li>)}
        </ol>
      </section>

      <section className={styles.rooms} id="rooms" aria-labelledby={`rooms-title-${locale}`}>
        <div className={`${styles.roomsCopy} ${styles.reveal}`}><h2 id={`rooms-title-${locale}`}>{copy.roomsTitle[0]}<br />{copy.roomsTitle[1]}</h2><span>{copy.roomsDescription}</span><Link href={`${base}/classroom`}>{copy.roomsCta} →</Link></div>
        <div className={`${styles.roomShelf} ${styles.reveal}`}>
          <header><strong>{copy.roomsHeader}</strong><span>{copy.roomsComing}</span></header>
          {copy.rooms.map(([date, title, detail]) => <article key={title}><time>{date}</time><div><h3>{title}</h3><p>{detail}</p></div><span>→</span></article>)}
        </div>
      </section>

      <section className={styles.pricing} id="pricing" aria-labelledby={`pricing-title-${locale}`}>
        <header className={`${styles.pricingIntro} ${styles.reveal}`}><p>{copy.pricingLabel}</p><h2 id={`pricing-title-${locale}`}>{copy.pricingTitle[0]}<br />{copy.pricingTitle[1]}</h2></header>
        <PricingCheckoutProvider locale={locale} basePath={base}>
          <div className={`${styles.planGrid} ${styles.reveal}`}>
            {copy.plans.map((plan) => {
              const isTrialCard = plan.price === "무료" || plan.price === "Free";
              // A learner who has already used their trial was still shown a
              // free-trial card, and clicking it opened a paid monthly
              // checkout — the server picks the non-trial price once
              // trial_used_at is set. Show them the monthly card instead.
              const trialSpent = isTrialCard && creditStatus?.trialUsed === true;
              const monthly = copy.plans[1];
              const ctaLabel = isTrialCard && !trialSpent ? copy.heroCta : copy.open;
              return (
                <article className={"featured" in plan ? styles.featuredPlan : undefined} key={plan.name}>
                  <div><span>{trialSpent ? monthly.name : plan.name}</span>{"featured" in plan && <b>{copy.featured}</b>}</div>
                  <h3>{trialSpent ? monthly.time : plan.time}</h3>
                  {/* deslop-ignore-next-line 09 -- 프로모션가와 종료 후 예정가를 명시적으로 비교 */}
                  {"comparePrice" in plan && <div className={styles.comparePrice}><span>{plan.compareLabel}</span><del>{plan.comparePrice}</del></div>}
                  <div className={styles.planPrice}><strong>{trialSpent ? monthly.price : plan.price}</strong>{trialSpent ? <span>{monthly.priceNote}</span> : "priceNote" in plan && <span>{plan.priceNote}</span>}</div>
                  <p>{trialSpent ? monthly.unit : plan.unit}</p><small>{trialSpent ? monthly.detail : plan.detail}</small>
                  {isAuthenticated ? (
                    <PricingCheckoutButton plan={plan.billingPlan as BillingPlan} pendingLabel={copy.checkoutOpening} label={<>{ctaLabel}<span>→</span></>} />
                  ) : (
                    <Link href={`${base}/billing?plan=${plan.billingPlan}`}>{ctaLabel}<span>→</span></Link>
                  )}
                </article>
              );
            })}
          </div>
          <PricingCheckoutMessage className={styles.pricingFootnote} />
          <p className={styles.pricingFootnote}>{copy.pricingFootnote}</p>
          <div className={styles.pricingFacts}><span>{copy.pricingNoCard}</span><span>{copy.pricingIncluded}</span></div>
        </PricingCheckoutProvider>
      </section>

      <section className={`${styles.faq} ${styles.reveal}`} id="faq" aria-labelledby={`faq-title-${locale}`}>
        <h2 id={`faq-title-${locale}`}>{copy.faqTitle}</h2>
        <div>{copy.faqs.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden>+</span></summary><p>{answer}</p></details>)}</div>
      </section>

      <section className={styles.finalCta}><p>{copy.finalTitle[0]}<br />{copy.finalTitle[1]}</p><Link href={isAuthenticated ? classroomPath : `${base}/login?mode=signup`}>{isAuthenticated ? copy.openClassroom : copy.finalCta}<span>→</span></Link></section>
      <footer className={styles.footer}><div><strong>Lecue</strong><p className={styles.footerTagline}>Built for what matters.</p></div><p>{copy.footerDescription}</p><div><Link href={`${base}/privacy`}>{copy.privacy}</Link><Link href={`${base}/terms`}>{copy.terms}</Link><Link href={`${base}/refund-policy`}>{copy.refund}</Link><a href={`mailto:${copy.support}`}>{copy.support}</a></div><small>{copy.recordingNotice}</small></footer>
    </main>
  );
}
