const labels = {
  monthly: { ko: "월간", en: "Monthly" },
  term: { ko: "4개월권", en: "4-month pass" },
  semester: { ko: "한 학기", en: "Semester" },
  trial: { ko: "무료 체험", en: "Free trial" },
  service_credit: { ko: "서비스 크레딧", en: "Service credit" },
} as const;

export function getPlanLabel(planCode: string | null | undefined, locale: "ko" | "en") {
  const entry = planCode ? labels[planCode as keyof typeof labels] : undefined;
  return entry ? entry[locale] : locale === "en" ? "No plan" : "요금제 없음";
}
