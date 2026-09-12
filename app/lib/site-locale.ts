/** Explicit choice wins; otherwise use the visitor's country, then browser preference. */
export function preferredSiteLocale(choice: string | undefined, country: string | null, acceptLanguage: string, path: string): "ko" | "en" {
  if (choice === "ko" || choice === "en") return choice;
  if (country && /^[a-z]{2}$/i.test(country) && !["XX", "T1"].includes(country.toUpperCase())) return country.toUpperCase() === "KR" ? "ko" : "en";
  const languages = acceptLanguage.split(",").map(entry => {
    const [language, ...params] = entry.trim().toLowerCase().split(";");
    const q = params.find(param => param.trim().startsWith("q="));
    return { language: language.split("-")[0], weight: q ? Number(q.trim().slice(2)) : 1 };
  }).filter(item => ["ko", "en"].includes(item.language) && item.weight > 0 && item.weight <= 1).sort((a, b) => b.weight - a.weight);
  const preferred = languages[0]?.language;
  if (preferred === "ko" || preferred === "en") return preferred;
  return "en";
}

/** Region controls which choices are prominent, independently of UI language. */
export function siteRegion(country: string | null, acceptLanguage: string): "kr" | "global" {
  return preferredSiteLocale(undefined, country, acceptLanguage, "/") === "ko" ? "kr" : "global";
}

export function languageSwitchUrl(href: string, locale: "ko" | "en") {
  // Public /ko and /en pages can differ from the stored preference. Their
  // app-entry links carry the displayed language through the existing explicit
  // choice flow; the proxy's default preference order stays unchanged.
  const url = new URL(href, "https://lecue.app");
  url.searchParams.set("lang", locale);
  return `${url.pathname}${url.search}${url.hash}`;
}
