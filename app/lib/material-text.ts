export type MaterialPage = { page: number; text: string };
export type MaterialChunk = { startPage: number; endPage: number; text: string };

export const MAX_NATIVE_TEXT_CHARACTERS = 500_000;

/** PostgreSQL JSON/text rejects NUL and unpaired UTF-16 surrogates. */
export function normalizeMaterialText(text: string): string {
  return text.replaceAll("\u0000", "").toWellFormed();
}

/** Text and delimited tables already contain their source; no model transcription. */
export function readTextMaterial(bytes: Uint8Array): MaterialPage[] {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n").trim();
  if (text.length > MAX_NATIVE_TEXT_CHARACTERS) throw new Error("TEXT_TOO_LARGE");
  if (/[\u0000-\u0008\u000e-\u001f]/u.test(text)) throw new Error("INVALID_TEXT");
  // Keep headings, CSV quotes, delimiters and terminology exactly as supplied.
  return text ? [{ page: 1, text }] : [];
}

/**
 * 색인 모델은 페이지마다 `## p.3` 형태의 머리글을 먼저 쓰도록 지시받는다.
 * 모델이 그 형식을 빠뜨려도 실제 추출 텍스트는 첫 구간으로 보존한다.
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
    // 페이지가 아닌 머리글(## TERMS 등)이 나오면 그 아래는 페이지 본문이 아니다.
    if (/^#{1,3}\s+\S/.test(line.trim())) {
      if (current?.text.trim()) pages.push({ ...current, text: current.text.trim() });
      current = null;
      continue;
    }
    // 머리글이 나오기 전 줄은 어느 페이지의 것인지 알 수 없으므로 버린다.
    if (current) current.text += `${line}\n`;
  }
  if (current?.text.trim()) pages.push({ ...current, text: current.text.trim() });
  const numbered = pages.filter((page) => page.page >= 1 && page.page <= 500).sort((a, b) => a.page - b.page);
  if (numbered.length) return numbered;

  // Some valid file reads ignore the requested page markers. Keep that text;
  // only the terms footer is metadata rather than searchable lecture content.
  const fallback = markdown.split(/^#{1,3}\s+TERMS\b/im, 1)[0].trim();
  return fallback ? [{ page: 1, text: fallback }] : [];
}

/**
 * 임베딩 단위로 묶는다. 한 페이지가 상한을 넘으면 그 페이지만 여러 청크로 쪼개고,
 * 짧은 페이지들은 인접한 것끼리 붙여 검색 단위가 지나치게 잘게 쪼개지지 않게 한다.
 */
export function chunkPages(pages: MaterialPage[], maxCharacters = 1_800, maxChunks = Infinity): MaterialChunk[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) throw new RangeError("Invalid material chunk size");
  const chunks: MaterialChunk[] = [];
  const append = (chunk: MaterialChunk) => {
    if (chunks.length >= maxChunks) throw new Error("MATERIAL_CHUNK_LIMIT");
    chunks.push(chunk);
  };
  let current: MaterialChunk | null = null;

  for (const page of pages) {
    const text = normalizeMaterialText(page.text).trim();
    if (!text) continue;

    if (text.length > maxCharacters) {
      if (current) { append(current); current = null; }
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + maxCharacters, text.length);
        const last = text.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          // Keep a valid pair together; even a one-unit budget must allow one
          // complete Unicode character rather than produce invalid strings.
          end += end - start === 1 ? 1 : -1;
        }
        append({ startPage: page.page, endPage: page.page, text: text.slice(start, end) });
        start = end;
      }
      continue;
    }

    if (!current || page.page !== current.endPage + 1 || current.text.length + text.length + 24 > maxCharacters) {
      if (current) append(current);
      current = { startPage: page.page, endPage: page.page, text };
    } else {
      // Preserve exact page boundaries for direct page-number questions.
      if (current.startPage === current.endPage) current.text = `## p.${current.startPage}\n${current.text}`;
      current.text += `\n\n## p.${page.page}\n${text}`;
      current.endPage = page.page;
    }
  }

  if (current) append(current);
  return chunks;
}
