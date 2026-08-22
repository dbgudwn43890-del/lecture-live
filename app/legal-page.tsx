import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./legal.module.css";

type LegalPageProps = {
  title: string;
  description: string;
  children: ReactNode;
};

export default function LegalPage({ title, description, children }: LegalPageProps) {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">Lecture Live</Link>
        <nav aria-label="문서 메뉴">
          <Link href="/privacy">개인정보처리방침</Link>
          <Link href="/terms">이용약관</Link>
          <Link className={styles.classroomLink} href="/classroom">강의실 열기</Link>
        </nav>
      </header>

      <section className={styles.hero}>
        <p>서비스 운영 기준</p>
        <h1>{title}</h1>
        <div>
          <p>{description}</p>
          <dl>
            <div><dt>작성일</dt><dd>2026년 8월 22일</dd></div>
            <div><dt>시행일</dt><dd>정식 서비스 공개일</dd></div>
          </dl>
        </div>
      </section>

      <aside className={styles.draftNotice}>
        <strong>정식 배포 전 확인할 내용</strong>
        <p>
          이 문서는 현재 구현과 예정된 시간 충전 정책을 반영한 운영 초안입니다. 공개 전 운영자 상호·대표자·주소·사업자등록번호·통신판매업 신고번호·문의 이메일, 실제 서버 리전과 결제대행사를 확정해야 합니다.
        </p>
      </aside>

      <article className={styles.content}>{children}</article>

      <footer className={styles.footer}>
        <strong>Lecture Live</strong>
        <div><Link href="/">홈</Link><Link href="/privacy">개인정보처리방침</Link><Link href="/terms">이용약관</Link></div>
        <small>강의자와 기관의 녹음 정책을 확인한 뒤 사용하세요.</small>
      </footer>
    </main>
  );
}
