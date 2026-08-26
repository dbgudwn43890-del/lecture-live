"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import styles from "./landing.module.css";

type Locale = "ko" | "en";
type Profile = { displayName: string; email: string; avatarUrl: string | null } | null;

function AvatarMark({ avatarUrl }: { avatarUrl: string | null }) {
  return avatarUrl ? (
    <img src={avatarUrl} alt="" referrerPolicy="no-referrer" />
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="4" /><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" /></svg>
  );
}

export default function ProfileMenu({
  locale, basePath, classroomPath, profile, planLabel, credits,
}: {
  locale: Locale;
  basePath: string;
  classroomPath: string;
  profile: Profile;
  planLabel: string;
  credits: number | null;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isEnglish = locale === "en";

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.profileMenu} ref={containerRef}>
      <button
        type="button"
        className={styles.headerAvatar}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={isEnglish ? "Account menu" : "계정 메뉴"}
        onClick={() => setOpen((current) => !current)}
      >
        <AvatarMark avatarUrl={profile?.avatarUrl ?? null} />
      </button>

      {open && (
        <div className={styles.profilePanel} role="menu">
          <div className={styles.profilePanelHeader}>
            <span className={styles.headerAvatar}><AvatarMark avatarUrl={profile?.avatarUrl ?? null} /></span>
            <span>
              <strong>{profile?.displayName || (isEnglish ? "My account" : "내 계정")}</strong>
              <small>{profile?.email}</small>
            </span>
          </div>

          <div className={styles.profilePlanRow}>
            <span><small>{isEnglish ? "Plan" : "요금제"}</small><strong>{planLabel}</strong></span>
            <span><small>{isEnglish ? "Credits" : "크레딧"}</small><strong>{credits !== null ? credits.toLocaleString(isEnglish ? "en-US" : "ko-KR") : "—"}</strong></span>
          </div>

          <Link className={styles.profileLink} href={classroomPath} onClick={() => setOpen(false)}>
            {isEnglish ? "Go to classroom" : "강의실로 이동"}
          </Link>
          <Link className={styles.profileLink} href={`${basePath}/billing`} onClick={() => setOpen(false)}>
            {isEnglish ? "Billing & plan" : "요금제 및 결제 관리"}
          </Link>

          <form className={styles.profileSignout} action={isEnglish ? "/auth/signout?next=/en/login" : "/auth/signout"} method="post">
            <button type="submit">{isEnglish ? "Sign out" : "로그아웃"}</button>
          </form>
        </div>
      )}
    </div>
  );
}
