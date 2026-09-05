const labels = {
  monthly: { ko: "Monthly", en: "Monthly" },
  term: { ko: "Term", en: "Term" },
  semester: { ko: "Semester", en: "Semester" },
  trial: { ko: "무료 체험", en: "Free trial" },
  service_credit: { ko: "서비스 크레딧", en: "Service credit" },
} as const;

export function getPlanLabel(planCode: string | null | undefined, locale: "ko" | "en") {
  const entry = planCode ? labels[planCode as keyof typeof labels] : undefined;
  return entry ? entry[locale] : locale === "en" ? "No plan" : "요금제 없음";
}
