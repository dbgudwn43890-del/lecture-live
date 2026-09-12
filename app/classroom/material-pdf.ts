import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";

type Entry = { promise: Promise<PDFDocumentProxy>; users: number; destroy(): void; timer?: ReturnType<typeof setTimeout> };

/** Share a document while pages are mounted; release its requests and worker afterward. */
export function createMaterialPdfRenderer(fetcher: typeof fetch = fetch, loadPdfJs = () => import("pdfjs-dist/legacy/build/pdf.mjs")) {
  const documents = new Map<string, Entry>();

  function acquire(documentId: string) {
    let entry = documents.get(documentId);
    if (!entry) {
      const controller = new AbortController();
      let task: PDFDocumentLoadingTask | undefined;
      let destroyed = false;
      const promise = (async () => {
        const response = await fetcher(`/api/materials?documentId=${encodeURIComponent(documentId)}`, { signal: controller.signal });
        const data = await response.json() as { url?: string };
        if (!response.ok || !data.url) throw new Error("Material preview unavailable");
        controller.signal.throwIfAborted();
        const pdfjs = await loadPdfJs();
        controller.signal.throwIfAborted();
        pdfjs.GlobalWorkerOptions.workerSrc = `/pdfjs/${pdfjs.version}/pdf.worker.min.mjs`;
        task = pdfjs.getDocument({ url: data.url });
        return task.promise;
      })();
      const created: Entry = { promise, users: 0, destroy() {
        if (destroyed) return;
        destroyed = true;
        controller.abort();
        void task?.destroy().catch(() => {});
      } };
      documents.set(documentId, created);
      promise.catch(() => {
        if (documents.get(documentId) === created) documents.delete(documentId);
        created.destroy();
      });
      entry = created;
    }
    clearTimeout(entry.timer);
    entry.users++;
    const current = entry;
    return { promise: current.promise, release() {
      if (--current.users) return;
      // React Strict Mode immediately reacquires after its effect cleanup.
      current.timer = setTimeout(() => {
        if (documents.get(documentId) === current) documents.delete(documentId);
        current.destroy();
      }, 0);
    } };
  }

  return function render(documentId: string, pageNumber: number, canvas: HTMLCanvasElement, onError: () => void) {
    const document = acquire(documentId);
    let cancelled = false;
    let task: RenderTask | undefined;
    void (async () => {
      try {
        const pdf = await document.promise;
        if (cancelled) return;
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 2 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        task = page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport });
        await task.promise;
      } catch {
        if (!cancelled) onError();
      }
    })();
    return () => {
      if (cancelled) return;
      cancelled = true;
      try { task?.cancel(); } finally { document.release(); }
    };
  };
}

export const renderMaterialPdfPage = createMaterialPdfRenderer();
