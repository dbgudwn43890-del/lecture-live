export const MAX_REQUESTED_MATERIAL_PAGES = 12;

/** Only numbers attached to a page label count; amounts and timestamps do not. */
export function requestedMaterialPages(question: string): { pages: number[]; limited: boolean } {
  const pages = new Set<number>();
  let limited = false;
  const add = (first: string, last?: string) => {
    const start = Number(first);
    const end = last ? Number(last) : start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1) return;
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    for (let page = low; page <= high; page++) {
      if (pages.has(page)) continue;
      if (pages.size >= MAX_REQUESTED_MATERIAL_PAGES) { limited = true; break; }
      pages.add(page);
    }
  };
  const number = "(\\d{1,6})";
  const range = "(?:[-–—~〜]|부터|에서|to)";
  const korean = new RegExp(`(?<![\\d.])${number}\\s*(?:(?:페이지|쪽)\\s*)?(?:${range}\\s*${number}\\s*)?(?:페이지|쪽)`, "giu");
  const englishLabel = "(?:pages?\\s*|pp?(?:\\.\\s*|\\s+))";
  const english = new RegExp(`\\b${englishLabel}${number}(?:\\s*${range}\\s*(?:${englishLabel})?${number})?(?![a-z\\d]|\\.\\d)`, "giu");
  for (const match of question.matchAll(korean)) add(match[1], match[2]);
  for (const match of question.matchAll(english)) add(match[1], match[2]);
  return { pages: [...pages].sort((a, b) => a - b), limited };
}

export type IndexedMaterialPageChunk = { start_page: number; end_page: number; text: string };

/** A legacy range may skip an empty page, so overlap alone is not evidence. */
export function indexedMaterialPageText(chunks: IndexedMaterialPageChunk[], page: number): string {
  return chunks.flatMap((chunk) => {
    if (page < chunk.start_page || page > chunk.end_page) return [];
    if (chunk.start_page === page && chunk.end_page === page) return [chunk.text];
    const headers = [...chunk.text.matchAll(/^## p\.(\d+)\s*$/gm)];
    const header = headers.findIndex((match) => Number(match[1]) === page);
    if (header < 0) return [];
    const start = headers[header].index! + headers[header][0].length;
    return [chunk.text.slice(start, headers[header + 1]?.index).trim()];
  }).filter(Boolean).join("\n").trim();
}
