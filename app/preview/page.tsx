import type { Metadata } from "next";
import Link from "next/link";

import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Lecture Live | 현장 강의 실시간 조교",
  description: "현장 강의를 실시간으로 기록하고, 질문한 시점까지의 수업 맥락으로 답합니다.",
};

const rooms = [
  { title: "경제학개론 · 증권시장", date: "오늘", duration: "1시간 18분", questions: "7개 질문" },
  { title: "재무관리 · 채권의 가격", date: "8월 20일", duration: "52분", questions: "4개 질문" },
  { title: "경영학원론 · 기업의 구조", date: "8월 18일", duration: "1시간 05분", questions: "9개 질문" },
];

const plans = [
  { name: "첫 체험", time: "60분", price: "무료", detail: "가입 계정당 한 번" },
  { name: "가볍게", time: "10시간", price: "12,900원", detail: "구매 후 90일" },
  { name: "한 학기", time: "30시간", price: "32,900원", detail: "구매 후 180일" },
  { name: "꾸준히", time: "60시간", price: "59,900원", detail: "구매 후 365일" },
];

const faqs = [
  {
    question: "온라인 강의용 서비스인가요?",
    answer: "아니요. 교실, 학원, 세미나처럼 같은 공간에서 듣는 현장 강의를 위해 만들고 있습니다.",
  },
  {
    question: "질문하는 동안 강의 기록이 멈추나요?",
    answer: "멈추지 않습니다. 답변을 만드는 동안에도 마이크 음성과 실시간 스크립트는 계속 이어집니다.",
  },
  {
    question: "모든 질문에 웹 검색을 사용하나요?",
    answer: "아닙니다. 강의 내용만으로 충분한지 모델이 판단하고, 최신 정보나 외부 확인이 필요할 때만 검색합니다.",
  },
  {
    question: "요금은 어떻게 계산할 예정인가요?",
    answer: "실제로 강의를 기록한 시간만 1초 단위로 차감합니다. 연결 중이거나 기록이 멈춘 시간, 저장된 내용을 다시 보는 시간에는 차감되지 않습니다.",
  },
  {
    question: "자동으로 다음 달 결제되나요?",
    answer: "아니요. 출시 초기에는 월 구독 없이 필요한 시간만 충전하는 방식으로 운영할 예정입니다.",
  },
  {
    question: "강의를 녹음해도 되나요?",
    answer: "강의자와 기관의 녹음 정책을 먼저 확인해야 합니다. 녹음이 허용된 환경에서만 사용해 주세요.",
  },
];

export default function LandingPreview() {
  return (
    <main className={styles.page} id="top">
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Lecture Live 홈">
          Lecture Live
        </Link>

        <nav className={styles.nav} aria-label="주요 메뉴">
          <a href="#how">작동 방식</a>
          <a href="#rooms">내 강의실</a>
          <a href="#pricing">요금</a>
          <a href="#faq">자주 묻는 질문</a>
        </nav>

        <div className={styles.headerActions}>
          <Link className={styles.loginLink} href="/login">로그인</Link>
          <Link className={styles.headerCta} href="/classroom">강의실 열기</Link>
        </div>
      </header>

      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroCopy}>
          <p className={styles.heroLabel}>현장 강의를 위한 실시간 조교</p>
          <h1 id="hero-title">놓친 설명,<br />수업 중에 바로.</h1>
          <p className={styles.heroDescription}>
            강의를 실시간으로 받아 적고, 질문한 시점까지의 수업 흐름을 바탕으로 답합니다.
            답을 만드는 동안에도 강의 기록은 계속됩니다.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryCta} href="/classroom">강의실 만들어보기 <span aria-hidden>→</span></Link>
            <a className={styles.secondaryCta} href="#how">작동 방식 보기</a>
          </div>
          <p className={styles.heroNote}>설치 없이 브라우저에서 시작합니다.</p>
        </div>

        <div className={styles.productFrame} aria-label="Lecture Live 제품 화면 예시">
          <div className={styles.productTopbar}>
            <span className={styles.productBrand}>Lecture Live</span>
            <span className={styles.productTitle}>경제학개론 · 증권시장</span>
            <span className={styles.liveState}><i />기록 중&nbsp;&nbsp;32:18</span>
          </div>

          <div className={styles.productPanes}>
            <section className={styles.questionPane} aria-labelledby="demo-question-title">
              <div className={styles.paneTitle}>
                <h2 id="demo-question-title">강의에 질문하기</h2>
                <span>1개 질문</span>
              </div>
              <div className={styles.demoMessages}>
                <div className={styles.userQuestion}>
                  <p>여기서 말하는 증권회사가 정확히 뭐야?</p>
                </div>
                <div className={styles.demoAnswer}>
                  <span>강의 조교 · AI</span>
                  <p>
                    기업과 투자자 사이를 연결하는 금융 중개 회사예요. 기업이 주식이나 채권으로
                    돈을 모을 때 발행 절차를 돕고, 투자자가 그것을 사고팔 수 있는 거래 창구도 제공합니다.
                  </p>
                  <small>이 질문은 강의 내용만으로 답했습니다.</small>
                </div>
              </div>
              <div className={styles.demoInput}>강의 내용에서 궁금한 점을 물어보세요 <span>↑</span></div>
            </section>

            <section className={styles.transcriptPane} aria-labelledby="demo-transcript-title">
              <div className={styles.paneTitle}>
                <h2 id="demo-transcript-title">실시간 스크립트</h2>
                <span>32:18</span>
              </div>
              <div className={styles.demoTranscript}>
                <p>증권은 재산상의 권리를 표시한 문서나 전자 기록을 말합니다.</p>
                <p>주식은 회사의 일부를 소유한다는 권리이고, 채권은 돈을 빌려주고 돌려받을 권리입니다.</p>
                <p>증권회사는 이런 증권을 기업이 발행할 수 있도록 돕고 투자자가 거래할 수 있게 연결합니다.</p>
                <p className={styles.currentTranscript}>여기서 발행을 돕는다는 건 단순히 서류를 대신 만든다는 의미가 아니라…</p>
              </div>
            </section>
          </div>
        </div>
      </section>

      <section className={styles.factStrip} aria-label="제품 핵심 특징">
        <p><strong>실시간</strong><span>말이 스크립트로 이어집니다</span></p>
        <p><strong>강의 맥락</strong><span>질문 시점까지 이해합니다</span></p>
        <p><strong>기록 지속</strong><span>답변 중에도 멈추지 않습니다</span></p>
        <p><strong>선택적 검색</strong><span>필요할 때만 외부를 확인합니다</span></p>
      </section>

      <section className={styles.explanation}>
        <div className={styles.explanationLead}>
          <h2>내 눈높이로<br />다시 이해하기</h2>
        </div>
        <div className={styles.explanationBody}>
          <p>
            강의가 어렵게 느껴지는 순간에는 같은 표현을 반복하는 답보다, 지금 이해할 수 있는 설명이
            필요합니다. Lecture Live는 질문한 시점까지의 강의 흐름을 바탕으로 생소한 개념을 쉬운 말로
            풀고, 필요한 배경과 예시를 더해 설명합니다.
          </p>
          <div className={styles.beforeAfter}>
            <div>
              <span>일반 검색</span>
              <p>질문의 앞뒤 수업 내용을 모른 채 일반적인 정의를 보여줍니다.</p>
            </div>
            <div>
              <span>Lecture Live</span>
              <p>지금까지 들은 강의 흐름을 바탕으로 눈높이에 맞는 쉬운 말과 예시로 설명합니다.</p>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.how} id="how" aria-labelledby="how-title">
        <div className={styles.sectionHeading}>
          <h2 id="how-title">듣고, 읽고, 묻기</h2>
        </div>
        <ol className={styles.steps}>
          <li>
            <span>1</span>
            <div><h3>강의실을 엽니다</h3><p>제목을 적고 마이크 권한을 허용하면 바로 기록을 시작합니다.</p></div>
          </li>
          <li>
            <span>2</span>
            <div><h3>강의를 들으며 읽습니다</h3><p>강사의 말이 문단 단위 스크립트로 이어지고 새로운 내용이 계속 추가됩니다.</p></div>
          </li>
          <li>
            <span>3</span>
            <div><h3>모르는 순간 질문합니다</h3><p>질문 시점까지의 강의 흐름을 바탕으로 짧고 이해 가능한 답을 받습니다.</p></div>
          </li>
        </ol>
      </section>

      <section className={styles.rooms} id="rooms" aria-labelledby="rooms-title">
        <div className={styles.roomsIntro}>
          <h2 id="rooms-title">수업 뒤에도<br />남는 맥락</h2>
          <p>최근 강의를 다시 열고, 당시 질문과 답변을 한곳에서 확인하는 공간입니다.</p>
          <Link href="/classroom">내 강의실로 이동 <span aria-hidden>→</span></Link>
        </div>

        <div className={styles.roomList} aria-label="내 강의실 화면 예시">
          <div className={styles.roomListHeader}>
            <div><strong>내 강의실</strong><span>최근 강의 3개</span></div>
            <button type="button" disabled>새 강의실</button>
          </div>
          {rooms.map((room) => (
            <article className={styles.roomRow} key={room.title}>
              <span className={styles.roomDate}>{room.date}</span>
              <div><h3>{room.title}</h3><p>{room.duration} · {room.questions}</p></div>
              <span className={styles.roomArrow} aria-hidden>→</span>
            </article>
          ))}
          <p className={styles.prototypeNote}>강의 저장 기능이 연결되면 실제 기록이 이곳에 표시됩니다.</p>
        </div>
      </section>

      <section className={styles.pricing} id="pricing" aria-labelledby="pricing-title">
        <div className={styles.pricingIntro}>
          <p>출시 예정 요금안 · 부가세 포함</p>
          <h2 id="pricing-title">기록한 시간만</h2>
          <p className={styles.pricingLead}>
            월 구독이나 자동결제 없이 필요한 시간만 충전합니다. 현재 베타에서는 결제가 발생하지 않으며,
            유료 전환 전에 확정 가격과 시작일을 다시 안내합니다.
          </p>
        </div>
        <div>
          <div className={styles.planList} aria-label="시간 충전 요금안">
            {plans.map((plan) => (
              <div className={styles.planRow} key={plan.name}>
                <span>{plan.name}</span>
                <strong>{plan.time}</strong>
                <b>{plan.price}</b>
                <small>{plan.detail}</small>
              </div>
            ))}
          </div>
          <div className={styles.pricingRules}>
            <p><span>차감</span>녹음 중인 시간만 1초 단위로 차감하며 연결·중지 시간은 제외</p>
            <p><span>포함</span>해당 강의의 질문, AI 답변, 필요한 경우의 웹 검색</p>
            <p><span>무료</span>저장된 스크립트와 답변 다시보기</p>
            <p><span>환불</span>구매 후 7일 이내 미사용은 전액, 사용 후에는 남은 시간 비율만큼 환불</p>
          </div>
          <p className={styles.pricingNotice}>
            시간이 적은 팩부터 먼저 차감하며 만료 30일·7일·1일 전에 알립니다. 법령이 정한 기준이 더
            유리한 경우에는 해당 기준을 우선 적용합니다.
          </p>
          <Link className={styles.pricingCta} href="/classroom">무료 베타 시작하기 <span aria-hidden>→</span></Link>
        </div>
      </section>

      <section className={styles.faq} id="faq" aria-labelledby="faq-title">
        <div className={styles.sectionHeading}>
          <h2 id="faq-title">시작 전에 확인하세요</h2>
        </div>
        <div className={styles.faqList}>
          {faqs.map((item) => (
            <details key={item.question}>
              <summary>{item.question}<span aria-hidden>+</span></summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className={styles.finalCta}>
        <p>다음 강의는,<br />놓치지 않게.</p>
        <Link href="/classroom">내 첫 강의실 열기 <span aria-hidden>→</span></Link>
      </section>

      <footer className={styles.footer}>
        <strong>Lecture Live</strong>
        <p>현장 강의를 이해하기 위한 실시간 조교</p>
        <div>
          <Link href="/privacy">개인정보처리방침</Link>
          <Link href="/terms">이용약관</Link>
          <span>문의 채널 준비 중</span>
        </div>
        <small>강의자와 기관의 녹음 정책을 확인한 뒤 사용하세요.</small>
      </footer>
    </main>
  );
}
