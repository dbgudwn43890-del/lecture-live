const labels = {
  monthly: { ko: "월간", en: "Monthly" },
  term: { ko: "기간권", en: "Term" },
  semester: { ko: "학기권", en: "Semester" },
  halfyear: { ko: "6개월권", en: "Half-year" },
  annual: { ko: "연간권", en: "Annual" },
  topup: { ko: "추가 충전", en: "Top-up" },
  trial: { ko: "무료 체험", en: "Free trial" },
  service_credit: { ko: "서비스 크레딧", en: "Service credit" },
} as const;

export function getPlanLabel(planCode: string | null | undefined, locale: "ko" | "en") {
  const entry = planCode ? labels[planCode as keyof typeof labels] : undefined;
  return entry ? entry[locale] : locale === "en" ? "No plan" : "요금제 없음";
}
