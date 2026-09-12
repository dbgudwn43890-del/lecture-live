"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import CreditUsage, { type UsageStatus } from "./credit-usage";
import { languageSwitchUrl } from "./lib/site-locale";

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
  locale, basePath, classroomPath, profile, creditStatus,
}: {
  locale: Locale;
  basePath: string;
  classroomPath: string;
  profile: Profile;
  creditStatus: UsageStatus | null;
}) {
  const [usage, setUsage] = useState(creditStatus);
  const [open, setOpen] = useState(false);
  // 워크스페이스 설정과 같은 규칙: lecue-theme 저장, html의 data-theme 적용.
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  useEffect(() => {
    const stored = window.localStorage.getItem("lecue-theme");
    if (stored === "dark" || stored === "light") setTheme(stored);
  }, []);
  function applyTheme(next: "system" | "light" | "dark") {
    setTheme(next);
    if (next === "system") {
      window.localStorage.removeItem("lecue-theme");
      document.documentElement.dataset.theme =
        window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
      window.localStorage.setItem("lecue-theme", next);
      document.documentElement.dataset.theme = next;
    }
  }
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const isEnglish = locale === "en";

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch("/api/credits", { cache: "no-store", signal: controller.signal })
      .then(async response => { if (response.ok) setUsage(await response.json()); })
      .catch(() => {});
    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Escape must not strand focus on a panel that no longer exists.
      triggerRef.current?.focus();
    }
    // Keyboard users landed nowhere when the panel opened; move them into it.
    panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      controller.abort();
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.profileMenu} ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.headerAvatar}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={isEnglish ? "Account menu" : "계정 메뉴"}
        onClick={() => setOpen((current) => !current)}
      >
        <AvatarMark avatarUrl={profile?.avatarUrl ?? null} />
      </button>

      {open && (
        <div className={styles.profilePanel} ref={panelRef}>
          <div className={styles.profilePanelHeader}>
            <span className={styles.headerAvatar}><AvatarMark avatarUrl={profile?.avatarUrl ?? null} /></span>
            <span>
              <strong>{profile?.displayName || (isEnglish ? "My account" : "내 계정")}</strong>
              <small>{profile?.email}</small>
            </span>
          </div>

          <div className={styles.profilePlanRow}>
            <CreditUsage status={usage} locale={locale} compact />
          </div>

          <Link className={styles.profileLink} href={languageSwitchUrl(classroomPath, locale)} prefetch={false} onClick={() => setOpen(false)}>
            {isEnglish ? "Go to classroom" : "강의실로 이동"}
          </Link>
          <Link className={styles.profileLink} href={`${basePath}/billing`} onClick={() => setOpen(false)}>
            {isEnglish ? "Billing & plan" : "요금제 및 결제 관리"}
          </Link>

          <div className={styles.profileThemeRow}>
            <small>{isEnglish ? "Theme" : "테마"}</small>
            <div role="group" aria-label={isEnglish ? "Theme" : "테마"}>
              {([["system", isEnglish ? "System" : "시스템"], ["light", isEnglish ? "Light" : "라이트"], ["dark", isEnglish ? "Dark" : "다크"]] as const).map(([id, label]) => (
                <button key={id} type="button" className={theme === id ? styles.themeActive : undefined} onClick={() => applyTheme(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <form className={styles.profileSignout} action={isEnglish ? "/auth/signout?next=/en/login" : "/auth/signout"} method="post">
            <button type="submit">{isEnglish ? "Sign out" : "로그아웃"}</button>
          </form>
        </div>
      )}
    </div>
  );
}
