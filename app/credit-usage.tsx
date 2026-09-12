"use client";

import { useEffect, useState } from "react";
import { getPlanLabel } from "./lib/plan-label";
import type { CreditStatus } from "./lib/credit-status";
import styles from "./credit-usage.module.css";

export type UsageStatus = Pick<CreditStatus, "credits"> & Partial<CreditStatus>;

export default function CreditUsage({ status, locale, compact = false, onRefresh }: {
  status: UsageStatus | null;
  locale: "ko" | "en";
  compact?: boolean;
  onRefresh?: () => void;
}) {
  // Match the server's first render, then display dates in the viewer's zone.
  const [timeZone, setTimeZone] = useState<string | null>(null);
  useEffect(() => { setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone); }, []);
  const en = locale === "en";
  const t = (ko: string, english: string) => en ? english : ko;
  const number = (value: number) => value.toLocaleString(en ? "en-US" : "ko-KR");
  const date = (value?: string | null) => {
    if (!value || !Number.isFinite(Date.parse(value))) return null;
    return new Date(value).toLocaleDateString(en ? "en-US" : "ko-KR", { year: "numeric", month: "short", day: "numeric", timeZone: timeZone ?? "UTC" });
  };
  const trial = status?.planCode === "trial";
  const end = date(status?.planEndsAt);
  const days = timeZone && status?.planEndsAt ? Math.max(0, Math.ceil((Date.parse(status.planEndsAt) - Date.now()) / 86_400_000)) : null;
  const period = end ? trial
    ? days === null ? t(`${end}까지`, `Ends ${end}`) : days === 0 ? t(`무료 체험 종료 · ${end}`, `Trial ended · ${end}`) : t(`무료 체험 ${days}일 남음 · ${end}까지`, `${days} ${days === 1 ? "day" : "days"} left · ends ${end}`)
    : days === 0 ? t(`${end} 종료`, `Ended ${end}`) : t(`${end}까지 이용`, `Current period ends ${end}`)
    : status?.planCode === "topup" ? t("추가 크레딧으로 이용 중", "Using extra credits") : null;
  const regular = status?.regularCredits;
  const extra = status?.topupCredits;
  const ready = typeof regular === "number" && typeof extra === "number"
    && Number.isFinite(status?.regularGrantedCredits) && Number.isFinite(status?.topupGrantedCredits)
    && regular + extra === status?.credits;

  function meter(label: string, remaining: number, granted: number, expiry: string | null | undefined, isExtra: boolean) {
    const percent = granted > 0 ? Math.min(100, Math.max(0, Math.round(remaining / granted * 100))) : 0;
    const expiryDate = date(expiry);
    const refill = !isExtra && status?.nextGrantAt && expiry
      && Date.parse(status.nextGrantAt) === Date.parse(expiry) && (status.nextGrantCredits ?? 0) > 0;
    if (isExtra && remaining === 0) return <div className={styles.emptyBucket}>
      <span>{label}</span><span className={styles.emptyAmount}>{t("0 크레딧", "0 credits")}</span>
    </div>;
    const showExpiry = expiryDate && (isExtra || refill || expiryDate !== end);
    return <div className={styles.bucket}>
      <div className={styles.label}><span>{label}</span><small>{t(`${percent}% 남음`, `${percent}% left`)}</small></div>
      <div className={styles.meter} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={granted || 1} aria-valuenow={Math.min(granted || 1, Math.max(0, remaining))} aria-valuetext={t(`${number(remaining)} 크레딧, ${percent}% 남음`, `${number(remaining)} credits, ${percent}% left`)}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className={styles.amount}><strong>{number(remaining)}</strong>{granted > 0 && <span> / {number(granted)}</span>}<span> {t("크레딧", "credits")}</span></div>
      {showExpiry && <p className={styles.expiry}>{refill ? t(`${expiryDate} 새 크레딧 지급`, `Refills ${expiryDate}`) : t(`${expiryDate} ${isExtra ? "가장 빠른 만료" : "만료"}`, `${isExtra ? "Earliest expiry" : "Expires"} ${expiryDate}`)}</p>}
      {!expiryDate && remaining === 0 && <p className={styles.expiry}>{t(isExtra ? "사용 가능한 추가 크레딧이 없어요" : "사용 가능한 기본 크레딧이 없어요", isExtra ? "No extra credits available" : "No plan credits available")}</p>}
    </div>;
  }

  return <section className={`${styles.root} ${compact ? styles.compact : ""}`} aria-label={t("플랜 및 사용량", "Plan and usage")}>
    <div className={styles.heading}>
      <strong>{status ? getPlanLabel(status.planCode, locale) : t("내 플랜", "My plan")}</strong>
      {period && <p className={styles.period}>{period}</p>}
    </div>
    {ready ? <div className={styles.buckets}>
      {meter(t(trial ? "무료 체험 크레딧" : "기본 크레딧", trial ? "Trial credits" : "Plan credits"), regular, status?.regularGrantedCredits ?? 0, status?.regularExpiresAt, false)}
      {meter(t("추가 크레딧", "Extra credits"), extra, status?.topupGrantedCredits ?? 0, status?.topupExpiresAt, true)}
    </div> : <div className={styles.unavailable}>
      {status && <span className={styles.total}>{number(status.credits)}<small> {t("크레딧", "credits")}</small></span>}
      <p>{t("세부 사용량을 확인하고 있어요.", "Checking usage details.")}{onRefresh && <button type="button" onClick={onRefresh}>{t("다시 확인", "Refresh")}</button>}</p>
    </div>}
  </section>;
}
