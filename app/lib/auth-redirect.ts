export function getOAuthFallbackNext(path: string, country: string | null, hasCode: boolean) {
  if (!hasCode || (path !== "/" && path !== "/en")) return null;

  const prefersEnglish = Boolean(country && country !== "KR" && country !== "XX");
  return path === "/en" || prefersEnglish ? "/en/classroom" : "/classroom";
}
