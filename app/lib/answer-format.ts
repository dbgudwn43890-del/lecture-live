export type AnswerSource = { title: string; url: string };

export function cleanAnswerText(text: string) {
  return text
    .replace(/\s*\(\s*\[[^\]\n]*\]\(https?:\/\/[^)\n]+\)\s*\)/gi, "")
    .replace(/\s*\[[^\]\n]*\]\(https?:\/\/[^)\n]+\)/gi, "")
    .replace(/\s*<https?:\/\/[^>\n]+>/gi, "")
    .replace(/\s*\(\s*https?:\/\/[^)\n]+\)/gi, "")
    .replace(/\s*https?:\/\/[^\s<]+/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanSources(sources: AnswerSource[], limit = 12) {
  const unique = new Map<string, AnswerSource>();

  for (const source of sources) {
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:") continue;
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (key.toLowerCase().startsWith("utm_") || ["gclid", "fbclid"].includes(key.toLowerCase())) {
          url.searchParams.delete(key);
        }
      }
      const normalizedUrl = url.toString();
      if (!unique.has(normalizedUrl)) unique.set(normalizedUrl, { title: source.title.trim(), url: normalizedUrl });
    } catch {
      // Ignore malformed provider URLs.
    }
  }

  const preferred: AnswerSource[] = [];
  const repeatedDomains: AnswerSource[] = [];
  const domains = new Set<string>();
  for (const source of unique.values()) {
    const domain = new URL(source.url).hostname;
    if (domains.has(domain)) repeatedDomains.push(source);
    else {
      domains.add(domain);
      preferred.push(source);
    }
  }
  return [...preferred, ...repeatedDomains].slice(0, limit);
}
