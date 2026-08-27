export type MaterialPage = { page: number; text: string };
export type MaterialChunk = { startPage: number; endPage: number; text: string };

/**
 * 색인 모델은 페이지마다 `## p.3` 형태의 머리글을 먼저 쓰도록 지시받는다.
 * 머리글 앞의 서두, 빈 페이지, 순서가 어긋난 응답은 모두 버리지 않고 정리한다.
 */
export function splitPages(markdown: string): MaterialPage[] {
  const pages: MaterialPage[] = [];
  let current: MaterialPage | null = null;
  for (const line of markdown.split("\n")) {
    const header = /^#{1,3}\s*p\.?\s*(\d{1,3})\b/i.exec(line.trim());
    if (header) {
      if (current?.text.trim()) pages.push({ ...current, text: current.text.trim() });
      current = { page: Number(header[1]), text: "" };
      continue;
    }
    // 머리글이 나오기 전 줄은 어느 페이지의 것인지 알 수 없으므로 버린다.
    if (current) current.text += `${line}\n`;
  }
  if (current?.text.trim()) pages.push({ ...current, text: current.text.trim() });
  return pages.filter((page) => page.page >= 1 && page.page <= 500).sort((a, b) => a.page - b.page);
}

/**
 * 임베딩 단위로 묶는다. 한 페이지가 상한을 넘으면 그 페이지만 여러 청크로 쪼개고,
 * 짧은 페이지들은 인접한 것끼리 붙여 검색 단위가 지나치게 잘게 쪼개지지 않게 한다.
 */
export function chunkPages(pages: MaterialPage[], maxCharacters = 1_800): MaterialChunk[] {
  const chunks: MaterialChunk[] = [];
  let current: MaterialChunk | null = null;

  for (const page of pages) {
    const text = page.text.trim();
    if (!text) continue;

    if (text.length > maxCharacters) {
      if (current) { chunks.push(current); current = null; }
      for (let start = 0; start < text.length; start += maxCharacters) {
        chunks.push({ startPage: page.page, endPage: page.page, text: text.slice(start, start + maxCharacters) });
      }
      continue;
    }

    if (!current || current.text.length + text.length + 1 > maxCharacters) {
      if (current) chunks.push(current);
      current = { startPage: page.page, endPage: page.page, text };
    } else {
      current.text += `\n${text}`;
      current.endPage = page.page;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
