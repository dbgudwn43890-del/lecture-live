"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, CreditCard, LogOut, X } from "lucide-react";
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
  const panelId = useId();
  // 워크스페이스 설정과 같은 규칙: lecue-theme 저장, html의 data-theme 적용.
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("lecue-theme");
      if (stored === "dark" || stored === "light") setTheme(stored);
    } catch { /* The account menu remains available when preferences are blocked. */ }
  }, []);
  function applyTheme(next: "system" | "light" | "dark") {
    setTheme(next);
    document.documentElement.dataset.theme = next === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : next;
    try {
      if (next === "system") window.localStorage.removeItem("lecue-theme");
      else window.localStorage.setItem("lecue-theme", next);
    } catch { /* Apply for this document when persistence is unavailable. */ }
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
    <div className={styles.profileMenu} ref={containerRef} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.headerAvatar}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={isEnglish ? "Account menu" : "계정 메뉴"}
        onClick={() => setOpen((current) => !current)}
      >
        <AvatarMark avatarUrl={profile?.avatarUrl ?? null} />
      </button>

      {open && (
        <div className={styles.profilePanel} ref={panelRef} id={panelId} role="dialog" aria-label={isEnglish ? "My account" : "내 계정"}>
          <div className={styles.profilePanelHeader}>
            <span className={styles.headerAvatar}><AvatarMark avatarUrl={profile?.avatarUrl ?? null} /></span>
            <span className={styles.profileIdentity}>
              <strong>{profile?.displayName || (isEnglish ? "My account" : "내 계정")}</strong>
              <small>{profile?.email}</small>
            </span>
            <button type="button" className={styles.profileClose} aria-label={isEnglish ? "Close account menu" : "계정 메뉴 닫기"} onClick={() => { setOpen(false); triggerRef.current?.focus(); }}><X size={18} aria-hidden="true" /></button>
          </div>

          <nav className={styles.profileActions} aria-label={isEnglish ? "Account navigation" : "계정 이동"}>
          <Link className={styles.profileLink} href={languageSwitchUrl(classroomPath, locale)} prefetch={false} onClick={() => setOpen(false)}>
            <BookOpen size={18} aria-hidden="true" /><span>{isEnglish ? "My classroom" : "내 강의실"}</span>
          </Link>
          <Link className={styles.profileLink} href={`${basePath}/billing`} onClick={() => setOpen(false)}>
            <CreditCard size={18} aria-hidden="true" /><span>{isEnglish ? "Plan and billing" : "요금제 및 결제 관리"}</span>
          </Link>
          </nav>

          <form className={styles.profileSignout} action={isEnglish ? "/auth/signout?next=/en/login" : "/auth/signout"} method="post">
            <button type="submit"><LogOut size={18} aria-hidden="true" /><span>{isEnglish ? "Sign out" : "로그아웃"}</span></button>
          </form>

          <details className={styles.profilePlanRow}>
            <summary>{isEnglish ? "Credits and usage" : "크레딧 및 사용량"}{usage && <strong>{usage.credits.toLocaleString(isEnglish ? "en-US" : "ko-KR")}</strong>}</summary>
            <CreditUsage status={usage} locale={locale} compact />
          </details>

          <div className={styles.profileThemeRow}>
            <label htmlFor={`${panelId}-theme`}>{isEnglish ? "Appearance" : "화면 테마"}</label>
            <select id={`${panelId}-theme`} value={theme} onChange={event => applyTheme(event.target.value as "system" | "light" | "dark")}>
              {([["system", isEnglish ? "System" : "시스템"], ["light", isEnglish ? "Light" : "라이트"], ["dark", isEnglish ? "Dark" : "다크"]] as const).map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
