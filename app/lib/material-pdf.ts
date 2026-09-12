import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_MATERIAL_PDF_BYTES = 20_000_000;
export const MAX_REQUESTED_PDF_PAGES = 12;
export const MAX_MATERIAL_PDF_PAGE_CHARACTERS = 80_000;
export const MATERIAL_PDF_TIMEOUT_MS = 12_000;

/** Physical PDF page numbers; an empty text value does not identify its cause. */
export async function readMaterialPdfPages(bytes: Uint8Array, requestedPages: readonly number[]): Promise<{
  pageCount: number;
  pages: { page: number; text: string; textTruncated?: true }[];
}> {
  if (!bytes.byteLength || bytes.byteLength > MAX_MATERIAL_PDF_BYTES) {
    throw new RangeError("Invalid material PDF size");
  }
  if (requestedPages.length > MAX_REQUESTED_PDF_PAGES ||
    requestedPages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
    throw new RangeError("Invalid requested PDF pages");
  }

  // PDF.js may transfer and detach this buffer. The caller keeps its own bytes.
  const loadingTask = getDocument({ data: bytes.slice() });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const extraction = (async () => {
      const pdf = await loadingTask.promise;
      const pageCount = pdf.numPages;
      const pages: { page: number; text: string; textTruncated?: true }[] = [];
      for (const pageNumber of [...new Set(requestedPages)].sort((a, b) => a - b)) {
        if (pageNumber > pageCount) continue;
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => "str" in item ? item.str : "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        pages.push({
          page: pageNumber,
          text: text.slice(0, MAX_MATERIAL_PDF_PAGE_CHARACTERS),
          ...(text.length > MAX_MATERIAL_PDF_PAGE_CHARACTERS ? { textTruncated: true as const } : {}),
        });
      }
      return { pageCount, pages };
    })();
    return await Promise.race([
      extraction,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PDF page extraction timed out")), MATERIAL_PDF_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // A timeout cancels the worker, too. Promise.race retains the rejection
    // handler on extraction while destroy rejects its pending PDF.js calls.
    await loadingTask.destroy();
  }
}
