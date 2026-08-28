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

const AUTH_DESTINATIONS = new Set(["/classroom", "/billing", "/en/classroom", "/en/billing"]);

export function getSafeAuthNext(value: string | null, fallback = "/classroom") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const url = new URL(value, "https://lecue.app");
    return AUTH_DESTINATIONS.has(url.pathname) ? `${url.pathname}${url.search}` : fallback;
  } catch {
    return fallback;
  }
}

// The pages that exist in both languages. /en/<path> is the English twin of
// <path>; everything else (the API, /auth, /stt-lab) has one form only.
const LOCALIZABLE_PATHS = ["/", "/login", "/classroom", "/billing", "/privacy", "/terms"];

/**
 * Where a request for `path` belongs once the visitor's language is known, or
 * null when it is already in the right place.
 *
 * The English direction alone used to be enforced, so switching back to Korean
 * from /en/classroom set the cookie and left the visitor on the English page.
 */
export function localePathFor(path: string, prefersEnglish: boolean) {
  const isEnglishPath = path === "/en" || path.startsWith("/en/");
  const koreanPath = isEnglishPath ? (path === "/en" ? "/" : path.slice(3)) : path;
  if (!LOCALIZABLE_PATHS.includes(koreanPath)) return null;

  // The landing page renders in either language at "/", so it is never moved —
  // redirecting it would fight the marketing links that point at the bare root.
  if (koreanPath === "/") return null;

  const target = prefersEnglish ? `/en${koreanPath}` : koreanPath;
  return target === path ? null : target;
}
