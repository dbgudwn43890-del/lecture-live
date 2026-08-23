import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./legal.module.css";

type LegalPageProps = {
  title: string;
  description: string;
  children: ReactNode;
  locale?: "ko" | "en";
};

export default function LegalPage({ title, description, children, locale = "ko" }: LegalPageProps) {
  const isEnglish = locale === "en";
  const basePath = isEnglish ? "/en" : "";
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href={basePath || "/"}>Lecue</Link>
        <nav aria-label={isEnglish ? "Legal documents" : "문서 메뉴"}>
          <Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link>
          <Link href={`${basePath}/terms`}>{isEnglish ? "Terms" : "이용약관"}</Link>
          <Link className={styles.classroomLink} href={`${basePath}/classroom`}>{isEnglish ? "Open a classroom" : "강의실 열기"}</Link>
        </nav>
      </header>

      <section className={styles.hero}>
        <p>{isEnglish ? "SERVICE RULES" : "서비스 운영 기준"}</p>
        <h1>{title}</h1>
        <div>
          <p>{description}</p>
          <dl>
            <div><dt>{isEnglish ? "Written" : "작성일"}</dt><dd>{isEnglish ? "August 23, 2026" : "2026년 8월 23일"}</dd></div>
            <div><dt>{isEnglish ? "Effective" : "시행일"}</dt><dd>{isEnglish ? "Public launch date" : "정식 서비스 공개일"}</dd></div>
          </dl>
        </div>
      </section>

      <aside className={styles.draftNotice}>
        <strong>{isEnglish ? "Items to complete before public launch" : "정식 배포 전 확인할 내용"}</strong>
        <p>
          {isEnglish
            ? "This draft reflects the current product, credit plans, and Paddle billing. Before launch, the operator's legal name, representative, address, registration details, support email, and actual server region must be added."
            : "이 문서는 현재 구현, 크레딧 요금제와 Paddle 결제를 반영한 운영 초안입니다. 공개 전 운영자 상호·대표자·주소·사업자등록번호·통신판매업 신고번호·문의 이메일과 실제 서버 리전을 확정해야 합니다."}
        </p>
      </aside>

      <article className={styles.content}>{children}</article>

      <footer className={styles.footer}>
        <strong>Lecue</strong>
        <div><Link href={basePath || "/"}>{isEnglish ? "Home" : "홈"}</Link><Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link><Link href={`${basePath}/terms`}>{isEnglish ? "Terms" : "이용약관"}</Link></div>
        <small>{isEnglish ? "Check the lecturer's and institution's recording rules before use." : "강의자와 기관의 녹음 정책을 확인한 뒤 사용하세요."}</small>
      </footer>
    </main>
  );
}
