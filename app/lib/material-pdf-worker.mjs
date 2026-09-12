import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Only this ingestion thread loads the bounded server artifact. Browser page
// rendering and the ordinary PDF package remain untouched.
const boundedWorker = await import(pathToFileURL(join(process.cwd(), ".pdfjs/material-pdf.worker.mjs")).href);
if (typeof boundedWorker.assertMaterialDecodeBudget !== "function") throw new Error("PDF_PARSE_FAILED");
globalThis.pdfjsWorker = boundedWorker;
const { bytes, maxCharacters, maxTokenBound } = workerData;
const task = getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 });
try {
  const pdf = await task.promise;
  boundedWorker.assertMaterialDecodeBudget();
  if (pdf.numPages > 500) throw new Error("PDF_PAGE_LIMIT");
  const pages = [];
  let characters = 0;
  let tokenBound = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    boundedWorker.assertMaterialDecodeBudget();
    const reader = page.streamTextContent().getReader();
    const pieces = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        // PDF.js sometimes recovers from malformed streams. A resource-limit
        // error must still reject the document, never save its readable prefix.
        boundedWorker.assertMaterialDecodeBudget();
        if (done) break;
        for (const item of value.items) {
          if (!("str" in item)) continue;
          const text = item.str.replaceAll("\u0000", "").toWellFormed().replace(/\s+/g, " ").trim();
          if (!text) continue;
          const separator = pieces.length ? 1 : 0;
          characters += text.length + separator;
          tokenBound += Buffer.byteLength(text, "utf8") + separator;
          if (characters > maxCharacters || tokenBound > maxTokenBound) throw new Error("MATERIAL_TEXT_LIMIT");
          pieces.push(text);
        }
      }
    } finally {
      await reader.cancel(new Error("Material text extraction stopped")).catch(() => {});
      page.cleanup();
    }
    if (pieces.length) pages.push({ page: pageNumber, text: pieces.join(" ") });
  }
  parentPort.postMessage({ result: { pageCount: pdf.numPages, pages } });
} catch (error) {
  let reason = error?.message;
  try { boundedWorker.assertMaterialDecodeBudget(); } catch { reason = "PDF_RESOURCE_LIMIT"; }
  const allowed = ["PDF_PAGE_LIMIT", "MATERIAL_TEXT_LIMIT", "PDF_RESOURCE_LIMIT"];
  parentPort.postMessage({ error: allowed.includes(reason) ? reason : "PDF_PARSE_FAILED" });
} finally {
  await task.destroy();
}
