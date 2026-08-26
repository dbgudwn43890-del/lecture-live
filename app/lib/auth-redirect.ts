export function getOAuthFallbackNext(
  path: string,
  country: string | null,
  hasCode: boolean,
  // An explicit language choice, when the visitor has made one. It outranks the
  // IP guess, which is what strands a Korean speaker abroad on the English site.
  chosenEnglish?: boolean,
) {
  if (!hasCode || (path !== "/" && path !== "/en")) return null;

  const prefersEnglish = chosenEnglish ?? Boolean(country && country !== "KR" && country !== "XX");
  return path === "/en" || prefersEnglish ? "/en/classroom" : "/classroom";
}

const AUTH_DESTINATIONS = new Set(["/classroom", "/classrooms", "/billing", "/en/classroom", "/en/classrooms", "/en/billing"]);

export function getSafeAuthNext(value: string | null, fallback = "/classroom") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const url = new URL(value, "https://lecue.app");
    return AUTH_DESTINATIONS.has(url.pathname) ? `${url.pathname}${url.search}` : fallback;
  } catch {
    return fallback;
  }
}
