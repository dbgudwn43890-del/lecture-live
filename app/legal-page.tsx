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
          <Link href={`${basePath}/refund-policy`}>{isEnglish ? "Refund Policy" : "환불 정책"}</Link>
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

      <article className={styles.content}>{children}</article>

      <footer className={styles.footer}>
        <strong>Lecue</strong>
        <div><Link href={basePath || "/"}>{isEnglish ? "Home" : "홈"}</Link><Link href={`${basePath}/privacy`}>{isEnglish ? "Privacy Policy" : "개인정보처리방침"}</Link><Link href={`${basePath}/terms`}>{isEnglish ? "Terms" : "이용약관"}</Link><Link href={`${basePath}/refund-policy`}>{isEnglish ? "Refund Policy" : "환불 정책"}</Link><a href="mailto:support@lecue.app">support@lecue.app</a></div>
        <small>{isEnglish ? "Check the lecturer's and institution's recording rules before use." : "강의자와 기관의 녹음 정책을 확인한 뒤 사용하세요."}</small>
      </footer>
    </main>
  );
}
