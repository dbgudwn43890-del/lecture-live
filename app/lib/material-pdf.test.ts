import assert from "node:assert/strict";
import test, { mock } from "node:test";

let pageCount = 10;
let requested: number[] = [];
let loaded = 0, destroyed = 0;
let failure: "load" | "page" | "text" | "pending" | null = null;
let items: ({ str: string } | { type: string })[] = [];
let received: number[] = [];
let rejectPendingText: ((error: Error) => void) | null = null;

mock.module("pdfjs-dist/legacy/build/pdf.mjs", { namedExports: {
  getDocument: ({ data }: { data: Uint8Array }) => {
    loaded++;
    received = [...data];
    structuredClone(data, { transfer: [data.buffer] });
    return {
      promise: failure === "load" ? Promise.reject(new Error("load failed")) : Promise.resolve({
        numPages: pageCount,
        async getPage(page: number) {
          requested.push(page);
          if (failure === "page") throw new Error("page failed");
          return { async getTextContent() {
            if (failure === "text") throw new Error("text failed");
            if (failure === "pending") await new Promise<never>((_, reject) => { rejectPendingText = reject; });
            return { items };
          } };
        },
      }),
      async destroy() {
        destroyed++;
        rejectPendingText?.(new Error("PDF destroyed"));
        rejectPendingText = null;
      },
    };
  },
} });

const {
  readMaterialPdfPages, MAX_MATERIAL_PDF_BYTES, MAX_REQUESTED_PDF_PAGES,
  MAX_MATERIAL_PDF_PAGE_CHARACTERS, MATERIAL_PDF_TIMEOUT_MS,
} = await import("./material-pdf.ts");
const bytes = () => new TextEncoder().encode("%PDF-1.7 synthetic");

test.beforeEach(() => {
  pageCount = 10;
  requested = [];
  loaded = destroyed = 0;
  failure = null;
  items = [{ str: "  일곱째\n페이지 " }, { type: "markedContent" }, { str: " 설명\t입니다. " }];
  received = [];
  rejectPendingText = null;
});

test("reads only requested page 7 and preserves the caller's buffer", async () => {
  const original = bytes();
  const snapshot = [...original];
  assert.deepEqual(await readMaterialPdfPages(original, [7]), {
    pageCount: 10,
    pages: [{ page: 7, text: "일곱째 페이지 설명 입니다." }],
  });
  assert.deepEqual(requested, [7]);
  assert.deepEqual(received, snapshot);
  assert.deepEqual([...original], snapshot);
  assert.equal(destroyed, 1);
});

test("returns the actual page count and skips out-of-range requests", async () => {
  pageCount = 503;
  const result = await readMaterialPdfPages(bytes(), [501, 504]);
  assert.equal(result.pageCount, 503);
  assert.deepEqual(result.pages.map((page) => page.page), [501]);
  assert.deepEqual(requested, [501]);
  assert.equal(destroyed, 1);
});

test("retains an existing page with no extracted text", async () => {
  items = [{ type: "markedContent" }, { str: " \n\t " }];
  assert.deepEqual(await readMaterialPdfPages(bytes(), [7]), {
    pageCount: 10, pages: [{ page: 7, text: "" }],
  });
});

test("reads duplicate requests once in physical page order", async () => {
  const result = await readMaterialPdfPages(bytes(), [7, 3, 7]);
  assert.deepEqual(requested, [3, 7]);
  assert.deepEqual(result.pages.map((page) => page.page), [3, 7]);
});

test("caps extracted text and reports that the page text was truncated", async () => {
  items = [{ str: "x".repeat(MAX_MATERIAL_PDF_PAGE_CHARACTERS + 1) }];
  const result = await readMaterialPdfPages(bytes(), [7]);
  assert.equal(result.pages[0].text.length, MAX_MATERIAL_PDF_PAGE_CHARACTERS);
  assert.equal(result.pages[0].textTruncated, true);
});

test("the extraction deadline destroys the PDF and cancels its pending text read", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  failure = "pending";
  const operation = readMaterialPdfPages(bytes(), [7]);
  const rejected = assert.rejects(operation, /PDF page extraction timed out/);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(rejectPendingText);
  context.mock.timers.tick(MATERIAL_PDF_TIMEOUT_MS);
  await rejected;
  assert.equal(destroyed, 1);
  assert.equal(rejectPendingText, null);
});

test("rejects oversized bytes and invalid or excessive pages before opening a PDF", async () => {
  await assert.rejects(readMaterialPdfPages(new Uint8Array(), [7]), RangeError);
  await assert.rejects(readMaterialPdfPages(new Uint8Array(MAX_MATERIAL_PDF_BYTES + 1), [7]), RangeError);
  await assert.rejects(readMaterialPdfPages(bytes(), Array.from({ length: MAX_REQUESTED_PDF_PAGES + 1 }, (_, index) => index + 1)), RangeError);
  for (const page of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readMaterialPdfPages(bytes(), [page]), RangeError);
  }
  assert.equal(loaded, 0);
  assert.equal(destroyed, 0);
});

for (const stage of ["load", "page", "text"] as const) {
  test(`destroys the loading task after a ${stage} failure`, async () => {
    failure = stage;
    await assert.rejects(readMaterialPdfPages(bytes(), [7]), new RegExp(`${stage} failed`));
    assert.equal(destroyed, 1);
  });
}
