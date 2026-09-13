import type { CSSProperties } from "react";
import Link from "next/link";
import ProfileMenu from "./profile-menu";
import { languageSwitchUrl } from "./lib/site-locale";
import { getSiteRegion } from "./lib/site-region";
import { STARTER_CREDITS, STARTER_DAYS } from "./lib/plans";
import SiteLanguageMenu from "./site-language-menu";
import { landingText } from "./landing-copy";
import LandingInteractions from "./landing-interactions";
import "./landing-experience.css";

type Locale = "ko" | "en";
type Profile = { displayName: string; email: string; avatarUrl: string | null };
type LandingCreditStatus = import("./credit-usage").UsageStatus;

export default async function LandingPage({ locale, isAuthenticated = false, profile, creditStatus }: {
  locale: Locale; isAuthenticated?: boolean; profile?: Profile | null; creditStatus?: LandingCreditStatus | null;
}) {
  const region = await getSiteRegion();
  const base = locale === "en" ? "/en" : "";
  const classroomPath = `${base}/classroom`;
  const classroomHref = languageSwitchUrl(classroomPath, locale);
  const startHref = isAuthenticated ? classroomHref : languageSwitchUrl(`${base}/login?next=${encodeURIComponent(classroomPath)}`, locale);
  const t = (text: string) => landingText(locale, text);
  const onlineLectureEnabled = process.env.NEXT_PUBLIC_ONLINE_LECTURE !== "off";
  return <LandingInteractions locale={locale}>

<a className="skip-link" href="#main">{t("본문으로 바로가기")}</a>
<header className="site-header"><div className="header-inner">
<a className="wordmark brand-lockup" href="#home" aria-label={t("Lecue 홈으로")}><span className="lecue-symbol" aria-hidden="true" />{"Lecue"}</a>
<nav aria-label={t("주요 메뉴")}><a href="#experience" data-open-demo>{t("직접 체험")}</a><a href="#how">{t("사용 방법")}</a><Link href={`${base}/billing`}>{locale === "en" ? "Plans" : "플랜"}</Link><a href="#faq">{t("궁금한 점")}</a></nav>
<div className="header-actions">
      <SiteLanguageMenu locale={locale} region={region} href={base || "/"} />
      {isAuthenticated ? <><ProfileMenu locale={locale} basePath={base} classroomPath={classroomPath} profile={profile ?? null} creditStatus={creditStatus ?? null} /><Link className="button button-small" href={classroomHref} prefetch={false}>{t("내 강의실")}</Link></> : <><Link className="login-link" href={languageSwitchUrl(`${base}/login`, locale)} prefetch={false}>{t("로그인")}</Link><Link className="button button-small" href={startHref} prefetch={false} data-analytics-event="landing_cta_click" data-analytics-placement="header">{t("무료로 시작")}</Link></>}
    </div>
</div></header>
<main id="main">
<section className="hero page-width" id="home" aria-labelledby="hero-title">
<div id="hero-intro" className="hero-intro">
<div className="hero-copy">
<h1 id="hero-title">{t("수업을 함께 듣는 AI.")}<br />{" "}{t("궁금하면, 물어보세요.")}</h1>
<p className="hero-description">{t("강의·자료를 바탕으로 답하고, 노트도 정리해요.")}</p>
<div className="hero-actions"><button className="button" type="button" data-open-demo aria-controls="demo-panel" aria-expanded="false">{t("30초만 체험하기")}{" "}<span aria-hidden="true">{"↗"}</span></button><a className="text-link" href={startHref} data-analytics-event="landing_cta_click" data-analytics-placement="hero">{t("무료로 내 강의 시작")}{" "}<span aria-hidden="true">{"→"}</span></a></div>
<p className="fine-print">{t("가입 없이 먼저 체험 · 시작할 때도 카드 등록 없이")}</p>
</div>
<div className="hero-excerpt" id="experience" aria-label={t("통계학 강의 예시")}>
<div className="excerpt-top"><span className="excerpt-listening"><svg aria-hidden="true" width="22" height="20" viewBox="0 0 22 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 8v4M6.5 4v12M11 1v18M15.5 5v10M20 8v4" /></svg>{t("통계학 · 샘플 강의")}</span><time>{"37:42"}</time></div>
<blockquote>{t("“조건부확률에서는 B가 높지만,")}<br />{" "}{t("주변확률에서는 관계가 뒤집힙니다.")}<br />
{" "}<mark>{t("앞에서 본 가중치가 다르기 때문이죠.")}</mark>{"”"}</blockquote>
<div className="excerpt-question"><span className="question-margin" aria-hidden="true">{"?"}</span><p>{t("둘 다 B가 높았는데,")}<br />{" "}{t("왜 합치면 A가 높은 거지?")}</p></div>
<button className="excerpt-try" type="button" data-open-demo aria-controls="demo-panel" aria-expanded="false"><span>{t("이 대목, 물어보기")}</span><span aria-hidden="true">{"↗"}</span></button>
<span className="example-label">{t("함께 들은 내용으로 답해요.")}</span>
</div>
</div>
<div className="demo-panel" id="demo-panel" hidden aria-labelledby="demo-title">
<div className="demo-header"><div><h2 id="demo-title">{t("샘플 강의에 물어보세요.")}</h2></div><button className="button button-outline demo-close" id="demo-close" type="button">{t("체험 닫기")}{" "}<span aria-hidden="true">{"×"}</span></button></div>
<div className="demo-layout">
<div className="lecture-side">
<div className="panel-label"><span>{t("함께 들은 강의 · 예시")}</span><time>{"37:42"}</time></div>
<blockquote className="lecture-quote">{t("“각 기기에서는 B가 높아도, 합치면 A가 높아질 수 있습니다. 앞서 본")}{" "}<mark>{t("가중치가 다르기 때문")}</mark>{t("이죠.”")}</blockquote>
<button className="button mobile-explain" id="mobile-explain" type="button" aria-controls="demo-answer" aria-expanded="false">{t("왜 반대인지 물어보기")}{" "}<span aria-hidden="true">{"→"}</span></button>
<table className="rates-table"><caption>{t("페이지 방문자 중 구매한 비율 · 예시 데이터")}</caption><thead><tr><th scope="col">{t("방문 기기")}</th><th scope="col">{t("페이지 A")}</th><th scope="col">{t("페이지 B")}</th></tr></thead><tbody><tr><th scope="row">{"PC"}</th><td>{"90%"}</td><td><strong>{"95%"}</strong></td></tr><tr><th scope="row">{t("모바일")}</th><td>{"10%"}</td><td><strong>{"20%"}</strong></td></tr><tr className="total-row"><th scope="row" id="total-label">{t("합치면")}</th><td id="total-a"><strong>{"82%"}</strong></td><td id="total-b">{"35%"}</td></tr></tbody></table>
<p className="table-footnote" id="table-footnote">{t("PC에서도, 모바일에서도 B가 높은데 합계는 반대예요.")}</p>
<div className="earlier-context" id="earlier-context" hidden><div className="panel-label"><span>{t("앞에서 나온 설명")}</span><time>{"37:05"}</time></div><p>{t("“A 방문자 100명 중 PC는 90명, 모바일은 10명입니다. B는 PC 20명, 모바일 80명이에요. 전체 비율은")}{" "}<strong>{t("각 기기의 방문자 비중으로 가중 평균")}</strong>{t("을 냅니다.”")}</p></div>
</div>
<div className="answer-side">
<div className="panel-label"><span>{t("Lecue에 물어보기")}</span><span>{t("강의 맥락으로")}</span></div>
<div className="demo-before" id="demo-before"><h3>{t("둘 다 B가 높은데,")}<br />{" "}{t("왜 합치면 반대예요?")}</h3><p>{t("앞에서 말한 ‘가중치’를 놓쳤어요.")}</p><button className="button" id="explain-button" type="button" aria-controls="demo-answer" aria-expanded="false">{t("이 질문 보내기")}{" "}<span aria-hidden="true">{"→"}</span></button><span className="fine-print">{t("샘플 답변 · 마이크 사용 없음")}</span></div>
<div className="demo-answer" id="demo-answer" hidden>
<p className="answer-question">{t("“왜 합치면 반대예요?”")}</p><h3>{t("비율을 섞는 재료의 양이")}<br />{" "}{t("서로 달랐어요.")}</h3>
<p>{t("앞에서 A에는")}{" "}<strong>{t("구매 비율이 높은 PC 방문자")}</strong>{t("가 훨씬 많다고 했어요. A와 B는 PC·모바일을 같은 비율로 섞은 평균이 아니에요.")}</p>
<div className="visitor-mix" aria-label={t("페이지별 방문자 구성")}><div className="mix-legend"><span><i className="pc-swatch" aria-hidden="true"></i>{"PC"}</span><span><i className="mobile-swatch" aria-hidden="true"></i>{t("모바일")}</span></div><div className="mix-row"><span>{"A"}</span><div className="mix-track" role="img" aria-label={t("A 방문자: PC 90명, 모바일 10명")} id="mix-a"><span className="mix-pc" style={{ "--portion": .9 } as CSSProperties}></span></div><span className="mix-value" id="mix-label-a">{"90 : 10"}</span></div><div className="mix-row"><span>{"B"}</span><div className="mix-track" role="img" aria-label={t("B 방문자: PC 20명, 모바일 80명")} id="mix-b"><span className="mix-pc" style={{ "--portion": .2 } as CSSProperties}></span></div><span className="mix-value" id="mix-label-b">{"20 : 80"}</span></div></div>
<button className="source-link" id="source-button" type="button" aria-controls="earlier-context" aria-expanded="false"><span aria-hidden="true">{"↖"}</span>{" "}{t("37:05 · 앞에서 설명한 근거 보기")}</button>
<div className="what-if"><button id="equalize-button" type="button" aria-pressed="false">{t("PC·모바일을 반반씩 비교하면?")}{" "}<span aria-hidden="true">{"→"}</span></button><p id="what-if-result" hidden aria-live="polite">{t("같은 비중으로 비교하면 A는 50%, B는 57.5%예요. 달랐던 것은 각 페이지의 방문자 구성이었어요.")}</p></div>
</div>
<p className="visually-hidden" id="demo-announcement" aria-live="polite"></p>
</div>
</div>
<div className="demo-footer"><button className="text-link" type="button" id="demo-return"><span aria-hidden="true">{"←"}</span>{" "}{t("홈으로 돌아가기")}</button><p id="demo-footer-copy">{t("예시 데이터로 잠깐 체험 중이에요.")}</p><a className="button button-small" href={startHref} data-analytics-event="landing_cta_click" data-analytics-placement="demo">{t("내 수업에서도 써보기")}{" "}<span aria-hidden="true">{"→"}</span></a></div>
</div>
<div className="hero-bottom"><p>{t("함께 듣고, 물어보고, 복습하세요.")}</p><a href="#how">{t("사용 방법")}{" "}<span aria-hidden="true">{"↓"}</span></a></div>
</section>
<section className="context-section" aria-labelledby="context-title"><div className="page-width context-layout"><div><h2 id="context-title">{t("방금 그 설명,")}<br />{" "}{t("이어서 물어보세요.")}</h2></div><div className="context-copy"><p>{t("앞에서 나온 예시와 조건까지,")}<br />{" "}{t("함께 들은 강의에서 답을 찾아요.")}</p><div className="margin-question"><span aria-hidden="true">{"“"}</span><p>{t("아까 말씀하신 조건이 뭐였지?")}</p></div></div></div></section>
<section className="page-width how-section" id="how" aria-labelledby="how-title">
<div className="section-heading"><h2 id="how-title">{t("수업 시작부터 복습까지.")}</h2></div>
<div className="journey">
<article className="journey-step"><span className="phase">{t("수업 전")}</span><h3>{t("시작하세요.")}</h3><p>{t("직접 시작을 눌러야 녹음해요. 강의 자료도 함께 올려두세요.")}</p><div className="start-snippet" aria-label={t("기록 시작 화면 예시")}><span>{t("오늘의 수업")}</span><strong>{t("통계학")}</strong><span className="snippet-rule"></span><span>{locale === "en" ? "English lecture" : t("한국어 강의")}</span><span className="snippet-action">{t("강의 시작")}{" "}<span aria-hidden="true">{"→"}</span></span></div></article>
<article className="journey-step"><span className="phase">{t("수업 중")}</span><h3>{t("물어보세요.")}</h3><p>{t("궁금한 대목을 질문하세요. 답을 읽는 동안에도 기록은 이어져요.")}</p><div className="question-snippet"><p>{t("방금 ‘가중치’가 무슨 뜻이었죠?")}</p><span>{t("앞에서 설명한 PC·모바일")}<br />{" "}{t("방문자 비중을 말해요.")}</span></div></article>
<article className="journey-step"><span className="phase">{t("수업 후")}</span><h3>{t("복습하세요.")}</h3><p>{t("강의와 질문을 과목별로 모으고, 복습 노트로 정리하세요.")}</p><div className="review-snippet"><span>{t("통계학")}</span><strong>{t("다시 볼 질문")}</strong><p>{t("전체와 부분의 결론이 왜 다를까?")}</p><span className="snippet-line"></span><span className="snippet-line short"></span></div></article>
</div><p className="recording-note">{t("강의자와 기관의 녹음 정책을 확인하고, 녹음이 허용된 수업에서 사용하세요.")}</p>
</section>
<section className="review-section" id="review" aria-labelledby="review-title"><div className="page-width review-layout">
<div className="review-copy"><h2 id="review-title">{t("내 질문에서")}<br />{" "}{t("시작하는 복습.")}</h2><p>{t("헷갈렸던 대목과 설명을")}<br />{" "}{t("복습 노트로 다시 꺼내보세요.")}</p><button className="text-link" id="preview-note-button" type="button" aria-controls="note-details" aria-expanded="false">{t("복습 노트 한 장 펼쳐보기")}{" "}<span aria-hidden="true">{"↗"}</span></button></div>
<article className="notebook" aria-label={t("복습 노트 예시")}><div className="notebook-top"><span>{t("통계학")}</span><span>{t("복습 노트 · 예시")}</span></div><h3>{t("전체와 부분의")}<br />{" "}{t("결론이 달라질 때.")}</h3><p className="note-subtitle">{t("심슨의 역설 · 조건부확률과 가중 평균")}</p><div className="note-question"><span>{t("내가 질문한 대목")}</span><p>{t("“둘 다 B가 높은데, 왜 합치면 반대예요?”")}</p></div><p className="note-body">{t("전체 비율은 각 집단의 비율을")}<br />{" "}{t("그 집단의 크기에 맞춰 섞은 값이다.")}<br />
<mark>{t("무엇이 얼마나 섞였는지부터 확인한다.")}</mark></p><details id="note-details"><summary>{t("숫자로 다시 확인하기")}{" "}<span aria-hidden="true">{"+"}</span></summary><div><p>{"A: 90% × 0.9 + 10% × 0.1 ="}{" "}<strong>{"82%"}</strong><br />{" "}{"B: 95% × 0.2 + 20% × 0.8 ="}{" "}<strong>{"35%"}</strong></p><p>{t("PC·모바일 비중을 반반으로 맞추면 A 50%, B 57.5%. 단순한 전체 비율만으로 페이지 자체의 효과를 판단하지 않는다.")}</p><p className="note-source">{t("개념 참고:")}{" "}<a href="https://www.stat.berkeley.edu/~stark/SticiGui/Text/experiments.htm">{t("UC Berkeley 통계학 강의")}</a><br />{" "}{t("페이지와 방문자 수는 체험용으로 구성한 예시입니다.")}</p></div></details><div className="notebook-bottom"><span>{t("이해한 대목부터, 다음 수업으로.")}</span><span className="lecue-symbol" aria-hidden="true" /></div></article>
</div></section>
<section className="page-width faq-section" id="faq" aria-labelledby="faq-title">
<div><h2 id="faq-title">{t("궁금한 점이")}<br />{" "}{t("남았나요?")}</h2><a className="support-link" href="mailto:support@lecue.app">{"support@lecue.app"}{" "}<span aria-hidden="true">{"↗"}</span></a></div>
<div className="faq-list">
<details><summary>{t("지금 무료로 쓸 수 있나요?")}<span aria-hidden="true">{"+"}</span></summary><p>{locale === "en" ? `Yes. Open your first classroom with a new account to receive ${STARTER_CREDITS} free credits, valid for ${STARTER_DAYS} days from issue. No card is required, and the trial does not renew automatically.` : `네. 새 계정으로 강의실을 처음 열면 ${STARTER_CREDITS} 크레딧을 무료로 받고, 지급일부터 ${STARTER_DAYS}일 동안 사용할 수 있어요. 카드 등록과 자동 결제는 없습니다.`} <Link href={`${base}/billing`}>{locale === "en" ? "View plans" : "플랜 보기"}</Link></p></details>
<details><summary>{t("30초 체험에는 가입이나 녹음이 필요한가요?")}<span aria-hidden="true">{"+"}</span></summary><p>{t("필요하지 않아요. 미리 구성한 통계 강의와 설명으로 Lecue의 흐름을 경험합니다. 마이크를 켜지 않으며, ‘체험 닫기’나 Escape 키로 바로 돌아올 수 있어요.")}</p><button className="text-link" type="button" data-open-demo>{t("지금 잠깐 체험하기 →")}</button></details>
<details><summary>{t("어떤 강의에서 쓰는 서비스인가요?")}<span aria-hidden="true">{"+"}</span></summary><p>{t(onlineLectureEnabled ? "현장 강의는 노트북 마이크로, 온라인 강의는 소리가 재생되는 브라우저 탭으로 듣습니다. 온라인 강의는 노트북 Chrome에서 강의 탭을 고르고 ‘탭 오디오 공유’를 켜 주세요." : "교실·학원·세미나처럼 같은 공간에서 듣는 현장 강의를 중심으로 만들고 있어요. 노트북 마이크가 강의자의 목소리를 또렷하게 담을 수 있는 환경에서 사용해 주세요.")}</p></details>
<details><summary>{t("강의를 녹음해도 괜찮나요?")}<span aria-hidden="true">{"+"}</span></summary><p>{t("강의자와 기관의 녹음 정책을 먼저 확인해 주세요. 필요한 허락을 받은 환경에서 사용해야 합니다. 사용 중에는 기록을 일시정지하거나 끝낼 수 있어요.")}</p></details>
<details><summary>{t("별도의 AI 구독이나 API 키가 필요한가요?")}<span aria-hidden="true">{"+"}</span></summary><p>{t("기본 사용에는 필요하지 않아요. Lecue 계정으로 시작할 수 있습니다. 개인 API 키를 연결하는 고급 설정도 있지만, 처음 사용할 때 설정할 필요는 없어요.")}</p></details>
<details><summary>{t("AI 답변을 그대로 믿어도 되나요?")}<span aria-hidden="true">{"+"}</span></summary><p>{t("음성 인식이나 AI 설명에는 오류가 생길 수 있어요. 중요한 내용은 강의 기록·수업 자료와 함께 확인해 주세요. 강의자의 설명과 다르다면 그 대목을 구체적으로 다시 물어볼 수 있습니다.")}</p></details>
<details><summary>{t("강의 기록과 질문은 어떻게 보관되나요?")}<span aria-hidden="true">{"+"}</span></summary><p>{t("로그인한 계정의 강의실에 모아 다시 확인할 수 있어요. 데이터 처리와 보관에 관한 자세한 내용은")}{" "}<a href={`${base}/privacy`}>{t("개인정보처리방침")}</a>{t("에서 확인할 수 있습니다.")}</p></details>
</div>
</section>
<section className="closing-section" aria-labelledby="closing-title"><div className="page-width closing-layout"><div><h2 id="closing-title">{t("놓친 부분을 묻고,")}<br />{" "}{t("다시 수업 속으로.")}</h2></div><div className="closing-actions"><a className="button button-light" href={startHref} data-analytics-event="landing_cta_click" data-analytics-placement="closing">{t("무료로 내 강의 시작")}{" "}<span aria-hidden="true">{"→"}</span></a><button className="closing-demo" type="button" data-open-demo>{t("30초만 체험하기")}</button><span>{locale === "en" ? `${STARTER_CREDITS} free credits · ${STARTER_DAYS} days from issue · No card needed` : `${STARTER_CREDITS} 크레딧 무료 · 지급일부터 ${STARTER_DAYS}일 · 카드 등록 없이`}</span></div></div></section>
</main>
<footer className="site-footer page-width"><div className="footer-top"><a className="wordmark brand-lockup" href="#home" aria-label={t("Lecue 홈으로")}><span className="lecue-symbol" aria-hidden="true" />{"Lecue"}</a><p>{t("수업의 흐름을, 내 속도로.")}</p><a className="back-top" href="#home">{t("맨 위로")}{" "}<span aria-hidden="true">{"↑"}</span></a></div><div className="footer-bottom"><span>{"© 2026 Lecue"}</span><nav aria-label={t("서비스 안내")}><a href={`${base}/privacy`}>{t("개인정보처리방침")}</a><a href={`${base}/terms`}>{t("이용약관")}</a><a href="mailto:support@lecue.app">{t("문의")}</a><button id="theme-toggle" type="button">{t("화면 밝기")}</button></nav></div></footer>

  </LandingInteractions>;
}
