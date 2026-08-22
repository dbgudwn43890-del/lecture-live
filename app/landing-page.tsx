import Link from "next/link";

import styles from "./preview/page.module.css";

type Locale = "ko" | "en";

const content = {
  ko: {
    homeLabel: "Lecue 홈",
    navLabel: "주요 메뉴",
    nav: ["작동 방식", "내 강의실", "요금", "자주 묻는 질문"],
    signIn: "로그인",
    open: "강의실 열기",
    language: "EN",
    heroLabel: "현장 강의를 위한 실시간 조교",
    heroTitle: ["놓친 설명을,", "수업이 끝나기 전에."],
    heroDescription: "강의를 따라 받아 적고, 방금까지의 수업 흐름으로 질문에 답합니다. 답변을 읽는 동안에도 기록은 계속됩니다.",
    heroCta: "무료 베타 시작하기",
    heroSecondary: "어떻게 작동하는지 보기",
    heroNote: "현재 베타는 카드 등록 없음 · 유료 출시 후 첫 7일 무료",
    promises: [
      ["5초 이내", "말이 문단으로 이어집니다"],
      ["기록 지속", "답변 중에도 강의를 놓치지 않습니다"],
      ["필요할 때만", "최신 정보는 외부에서 확인합니다"],
      ["모델 선택", "기본 AI 또는 내 API 키를 씁니다"],
    ],
    storyLabel: "세 단계로 이어지는 수업 흐름",
    storyTitle: ["기록하고,", "질문하고,", "놓치지 않습니다."],
    stories: [
      {
        label: "1 · 기록",
        title: "강사의 말이 문단으로 쌓입니다",
        description: "강사의 말이 짧은 문장 조각이 아니라 읽기 좋은 문단으로 쌓입니다. 시간 숫자보다 지금 설명의 흐름에 집중할 수 있습니다.",
      },
      {
        label: "2 · 질문",
        title: "모르는 순간, 바로 물어봅니다",
        description: "강의 문장을 반복하는 대신 낯선 용어를 풀고, 실제로 누가 무엇을 하는지 예시와 흐름으로 설명합니다.",
      },
      {
        label: "3 · 계속",
        title: "답을 읽는 동안에도 수업은 이어집니다",
        description: "질문과 답변은 왼쪽에서, 실시간 스크립트는 오른쪽에서 따로 움직입니다. 어느 쪽을 읽어도 녹음은 계속됩니다.",
      },
    ],
    demoTitle: "질문과 강의가 나란히 흐릅니다",
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
    roomsLabel: "내 강의실",
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
    pricingLabel: "출시 예정 요금 · 부가세 포함",
    pricingTitle: ["한 달 수업을,", "빠짐없이 따라가게."],
    pricingDescription: "월 13,900원에 정규 수업 약 80시간을 기록할 수 있습니다. 모든 유료 상품에서 기록, 질문, 강의실 맥락과 필요한 검색을 그대로 제공합니다.",
    pricingNoCard: "체험 시작 전 결제일·금액 별도 필수 확인",
    pricingPerSecond: "실제 녹음한 시간만 차감",
    pricingIncluded: "모든 기능·질문·필요한 검색 포함",
    pricingCta: "무료 베타 시작하기",
    plans: [
      { name: "첫 체험", time: "7일", price: "무료", unit: "수업 1회 · 최대 3시간", detail: "계정당 한 번 · 자동결제 조건 확인 후 시작" },
      { name: "월간", time: "1개월", price: "13,900원", unit: "강의 기록 80시간", detail: "7일 무료 후 월 자동 갱신", featured: true },
      { name: "한 학기", time: "6개월", price: "74,900원", unit: "강의 기록 480시간", detail: "한 번 결제 · 자동 갱신 없음" },
    ],
    featured: "출시 추천",
    faqTitle: "시작 전에 확인하세요",
    faqs: [
      ["온라인 강의용 서비스인가요?", "아니요. 교실, 학원, 세미나처럼 같은 공간에서 듣는 현장 강의를 우선해 만들고 있습니다."],
      ["질문하는 동안 강의 기록이 멈추나요?", "멈추지 않습니다. 답변을 만드는 동안에도 마이크 음성과 스크립트는 계속 이어집니다."],
      ["모든 질문에 웹 검색을 사용하나요?", "아닙니다. 강의 내용만으로 충분한지 모델이 판단하고, 최신 정보나 외부 확인이 필요할 때만 검색합니다."],
      ["무료 체험이 끝나면 바로 결제되나요?", "무료 체험을 시작하려면 결제수단을 등록하고 ‘표시된 날짜에 13,900원, 이후 매월 자동결제’ 조건에 별도로 동의해야 합니다. 동의한 경우 체험 종료 시 결제되며, 첫 결제 전에 취소하면 0원입니다. 동의하지 않으면 체험은 시작되지 않습니다."],
      ["요금제 시간은 실제 대학 수업에 충분한가요?", "월간은 80시간, 한 학기권은 6개월 동안 480시간을 제공합니다. 한 번의 수업은 최대 3시간이며 실제 녹음 시간만 계산합니다. 월간은 매달 갱신되고 한 학기권은 자동 갱신되지 않습니다."],
      ["지난 수업도 답변에 반영되나요?", "같은 강의실에 저장한 이전 수업 중 질문과 관련된 부분만 찾아 보조 맥락으로 사용합니다. 다른 강의실의 내용은 섞지 않습니다."],
      ["제 OpenAI·Claude·Gemini 키를 쓸 수 있나요?", "네. 현재 탭에서 한 번만 쓰거나 계정에 암호화해 저장할 수 있습니다. 해당 공급자의 모델 비용은 본인 계정에 별도로 청구됩니다."],
      ["강의를 녹음해도 되나요?", "강의자와 기관의 녹음 정책을 먼저 확인하고, 녹음이 허용된 환경에서만 사용해야 합니다."],
    ],
    finalTitle: ["다음 설명은,", "놓치지 않게."],
    finalCta: "첫 강의실 열기",
    footerDescription: "현장 강의를 따라가며 바로 이해하는 실시간 조교",
    privacy: "개인정보처리방침",
    terms: "이용약관",
    support: "문의 채널 준비 중",
    recordingNotice: "강의자와 기관의 녹음 정책을 확인한 뒤 사용하세요.",
  },
  en: {
    homeLabel: "Lecue home",
    navLabel: "Main navigation",
    nav: ["How it works", "My classrooms", "Pricing", "FAQ"],
    signIn: "Sign in",
    open: "Open a classroom",
    language: "한국어",
    heroLabel: "A live assistant for in-person lectures",
    heroTitle: ["Catch the explanation", "before class moves on."],
    heroDescription: "Lecue follows the lecture, then answers from everything said up to the moment you ask. Recording continues while you read the answer.",
    heroCta: "Start the free beta",
    heroSecondary: "See how it works",
    heroNote: "No card during beta · The first 7 days are free at paid launch",
    promises: [
      ["Within 5 seconds", "Speech becomes readable paragraphs"],
      ["Still recording", "Questions never pause the lecture"],
      ["Only when needed", "Current facts are checked outside"],
      ["Your choice", "Use Lecue AI or your own API key"],
    ],
    storyLabel: "One classroom flow in three steps",
    storyTitle: ["Capture.", "Ask.", "Keep up."],
    stories: [
      { label: "1 · Capture", title: "The lecturer's words build into paragraphs", description: "The lecturer's words build into readable paragraphs instead of scattered fragments. Stay with the idea rather than a stream of timestamps." },
      { label: "2 · Ask", title: "Ask the moment an explanation stops making sense", description: "Lecue unpacks unfamiliar terms and shows who does what through concrete examples instead of repeating the lecture sentence." },
      { label: "3 · Continue", title: "Class keeps moving while you read", description: "Questions and answers scroll on one side; the live transcript moves on the other. Recording continues whichever side you are reading." },
    ],
    demoTitle: "Questions and the lecture move side by side",
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
    roomsLabel: "My classrooms",
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
    pricingLabel: "Planned launch pricing · local taxes may apply",
    pricingTitle: ["A full month of class.", "Nothing important missed."],
    pricingDescription: "$9.99 a month covers about 80 hours of regular classes. Every paid option includes transcription, questions, classroom context, and needed search.",
    pricingNoCard: "Trial requires a clear recurring-billing agreement",
    pricingPerSecond: "Only active recording time is deducted",
    pricingIncluded: "Every feature, question, and needed search",
    pricingCta: "Start the free beta",
    plans: [
      { name: "First try", time: "7 days", price: "Free", unit: "One lecture · up to 3 hours", detail: "Once per account · starts after billing disclosure" },
      { name: "Monthly", time: "1 month", price: "$9.99", unit: "80 recording hours", detail: "7 days free, then monthly renewal", featured: true },
      { name: "Semester", time: "6 months", price: "$54", unit: "480 recording hours", detail: "One payment · no automatic renewal" },
    ],
    featured: "Launch pick",
    faqTitle: "Before you start",
    faqs: [
      ["Is this for online courses?", "No. Lecue is designed first for classrooms, seminars, workshops, and other lectures you attend in person."],
      ["Does recording stop while I ask?", "No. The microphone and transcript continue while an answer is being prepared."],
      ["Does every answer use web search?", "No. The model decides whether the lecture is enough and searches only when current information or outside verification is needed."],
      ["Will I be charged as soon as the trial ends?", "Starting the trial requires a payment method and separate acceptance of ‘$9.99 on the displayed date, then monthly until cancelled.’ If accepted, the first charge occurs when the trial ends. Cancel before then and the charge is $0. Without that acceptance, the trial does not start."],
      ["Is the allowance enough for a real class schedule?", "Monthly includes 80 recording hours, and Semester includes 480 hours across six months. Each lecture can run for up to 3 hours and only active recording counts. Monthly renews each month; Semester does not renew automatically."],
      ["Can answers use earlier lectures?", "Yes. Lecue retrieves only relevant excerpts from earlier lectures in the same classroom as supporting context. It never mixes in another classroom."],
      ["Can I use my own OpenAI, Claude, or Gemini key?", "Yes. Use it once in the current tab or save it encrypted to your account. That provider bills its own model charges separately."],
      ["May I record any lecture?", "Check the lecturer's, institution's, and local recording rules first. Use Lecue only where recording is permitted."],
    ],
    finalTitle: ["Stay with the next explanation", "from start to finish."],
    finalCta: "Open my first classroom",
    footerDescription: "A live assistant that helps you follow and understand in-person lectures",
    privacy: "Privacy Policy",
    terms: "Terms of Service",
    support: "Support channel coming soon",
    recordingNotice: "Check the lecturer's and institution's recording rules before use.",
  },
} as const;

export default function LandingPage({ locale }: { locale: Locale }) {
  const copy = content[locale];
  const base = locale === "en" ? "/en" : "";

  return (
    <main className={styles.page} id="top">
      <header className={styles.header}>
        <Link className={styles.brand} href={base || "/"} aria-label={copy.homeLabel}>Lecue</Link>
        <nav className={styles.nav} aria-label={copy.navLabel}>
          <a href="#how">{copy.nav[0]}</a>
          <a href="#rooms">{copy.nav[1]}</a>
          <a href="#pricing">{copy.nav[2]}</a>
          <a href="#faq">{copy.nav[3]}</a>
        </nav>
        <div className={styles.headerActions}>
          <Link className={styles.languageLink} href={locale === "en" ? "/" : "/en"}>{copy.language}</Link>
          <Link className={styles.loginLink} href={`${base}/login`}>{copy.signIn}</Link>
          <Link className={styles.headerCta} href={`${base}/classroom`}>{copy.open}</Link>
        </div>
      </header>

      <section className={styles.hero} aria-labelledby={`hero-title-${locale}`}>
        <div className={styles.heroCopy}>
          <p className={styles.heroLabel}>{copy.heroLabel}</p>
          <h1 id={`hero-title-${locale}`}>{copy.heroTitle[0]}<br />{copy.heroTitle[1]}</h1>
          <p className={styles.heroDescription}>{copy.heroDescription}</p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryCta} href={`${base}/classroom`}>{copy.heroCta}<span aria-hidden>→</span></Link>
            <a className={styles.secondaryCta} href="#how">{copy.heroSecondary}</a>
          </div>
          <p className={styles.heroNote}>{copy.heroNote}</p>
        </div>

        <div className={`${styles.productFrame} ${styles.heroProductFrame}`} aria-label={copy.demoTitle}>
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

      <section className={styles.promiseStrip} aria-label={locale === "en" ? "Product promises" : "제품 핵심 특징"}>
        {copy.promises.map(([title, detail]) => <p key={title}><strong>{title}</strong><span>{detail}</span></p>)}
      </section>

      <section className={styles.storySection} id="how" aria-labelledby={`story-title-${locale}`}>
        <header className={`${styles.storyHeader} ${styles.reveal}`}>
          <p>{copy.storyLabel}</p>
          <h2 id={`story-title-${locale}`}>{copy.storyTitle.map((line) => <span key={line}>{line}</span>)}</h2>
        </header>

        {copy.stories.map((story, index) => (
          <article className={`${styles.story} ${index % 2 ? styles.storyReverse : ""} ${styles.reveal}`} key={story.title}>
            <div className={styles.storyCopy}><span>{story.label}</span><h3>{story.title}</h3><p>{story.description}</p></div>
            <div className={`${styles.storyArt} ${styles[`storyArt${index + 1}`]}`} aria-hidden>
              {index === 0 && <><div className={styles.miniMic}><i /></div><div className={styles.inkTrail} /><div className={styles.paragraphSheet}><i /><i /><i /><i /></div></>}
              {index === 1 && <><div className={styles.termBubble}>?</div><div className={styles.explainPath} /><div className={styles.plainAnswer}><i /><i /><i /><span>{locale === "en" ? "plain example" : "쉬운 예시"}</span></div></>}
              {index === 2 && <><div className={styles.parallelTrack}><span>REC</span><i /><i /><i /></div><div className={styles.readingPane}><i /><i /><i /></div><div className={styles.livePane}><i /><i /><i /><i /></div></>}
            </div>
          </article>
        ))}
      </section>

      <section className={styles.rooms} id="rooms" aria-labelledby={`rooms-title-${locale}`}>
        <div className={`${styles.roomsCopy} ${styles.reveal}`}><p>{copy.roomsLabel}</p><h2 id={`rooms-title-${locale}`}>{copy.roomsTitle[0]}<br />{copy.roomsTitle[1]}</h2><span>{copy.roomsDescription}</span><Link href={`${base}/classroom`}>{copy.roomsCta} →</Link></div>
        <div className={`${styles.roomShelf} ${styles.reveal}`}>
          <header><strong>{copy.roomsHeader}</strong><span>{copy.roomsComing}</span></header>
          {copy.rooms.map(([date, title, detail]) => <article key={title}><time>{date}</time><div><h3>{title}</h3><p>{detail}</p></div><span>→</span></article>)}
        </div>
      </section>

      <section className={styles.pricing} id="pricing" aria-labelledby={`pricing-title-${locale}`}>
        <header className={`${styles.pricingIntro} ${styles.reveal}`}><p>{copy.pricingLabel}</p><h2 id={`pricing-title-${locale}`}>{copy.pricingTitle[0]}<br />{copy.pricingTitle[1]}</h2><span>{copy.pricingDescription}</span></header>
        <div className={styles.planGrid}>
          {copy.plans.map((plan) => <article className={"featured" in plan ? styles.featuredPlan : undefined} key={plan.name}>
            <div><span>{plan.name}</span>{"featured" in plan && <b>{copy.featured}</b>}</div>
            <h3>{plan.time}</h3><strong>{plan.price}</strong><p>{plan.unit}</p><small>{plan.detail}</small>
            <Link href={`${base}/classroom`}>{plan.price === "무료" || plan.price === "Free" ? copy.heroCta : copy.open}<span>→</span></Link>
          </article>)}
        </div>
        <div className={styles.pricingFacts}><span>{copy.pricingNoCard}</span><span>{copy.pricingPerSecond}</span><span>{copy.pricingIncluded}</span></div>
        <Link className={styles.pricingCta} href={`${base}/classroom`}>{copy.pricingCta}<span>→</span></Link>
      </section>

      <section className={styles.faq} id="faq" aria-labelledby={`faq-title-${locale}`}>
        <h2 id={`faq-title-${locale}`}>{copy.faqTitle}</h2>
        <div>{copy.faqs.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden>+</span></summary><p>{answer}</p></details>)}</div>
      </section>

      <section className={styles.finalCta}><p>{copy.finalTitle[0]}<br />{copy.finalTitle[1]}</p><Link href={`${base}/classroom`}>{copy.finalCta}<span>→</span></Link></section>
      <footer className={styles.footer}><strong>Lecue</strong><p>{copy.footerDescription}</p><div><Link href={`${base}/privacy`}>{copy.privacy}</Link><Link href={`${base}/terms`}>{copy.terms}</Link><span>{copy.support}</span></div><small>{copy.recordingNotice}</small></footer>
    </main>
  );
}
