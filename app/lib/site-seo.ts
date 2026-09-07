export const SITE_ORIGIN = "https://www.lecue.app";
const PUBLIC_PAGES = ["", "/privacy", "/terms", "/refund-policy", "/billing"];

/** Stable public language URLs; root remains a locale-adaptive entry point. */
export function publicPagePair(path: string) {
  const base = path === "/" || path === "/ko" || path === "/en" ? "" : path.startsWith("/en/") ? path.slice(3) : path;
  if (!PUBLIC_PAGES.includes(base)) return null;
  return { ko: base || "/ko", en: `/en${base}` };
}

export function pageSearchMetadata(path: string, locale: "ko" | "en") {
  const pair = publicPagePair(path);
  if (!pair) return { robots: { index: false, follow: true } };
  const canonical = path === "/" ? pair[locale] : path;
  return {
    robots: { index: true, follow: true },
    alternates: {
      canonical: `${SITE_ORIGIN}${canonical}`,
      languages: { ko: `${SITE_ORIGIN}${pair.ko}`, en: `${SITE_ORIGIN}${pair.en}`, ...(pair.ko === "/ko" ? { "x-default": `${SITE_ORIGIN}/` } : {}) },
    },
  };
}

export const INDEXABLE_PATHS = PUBLIC_PAGES.flatMap(base => [base || "/ko", `/en${base}`]);
