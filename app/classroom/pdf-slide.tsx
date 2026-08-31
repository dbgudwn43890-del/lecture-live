"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

export default function PdfSlide({ url, page, title, openLabel }: { url: string; page: number; title: string; openLabel: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setFailed(false);
    setDocument(null);

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        const task = pdfjs.getDocument({ url });
        loadingTask = task;
        const loaded = await task.promise;
        if (!cancelled) setDocument(loaded);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;

    void (async () => {
      try {
        const pdfPage = await document.getPage(Math.min(Math.max(1, page), document.numPages));
        if (cancelled || !frameRef.current || !canvasRef.current) return;

        const base = pdfPage.getViewport({ scale: 1 });
        const availableWidth = frameRef.current.clientWidth;
        const availableHeight = frameRef.current.clientHeight;
        const cssScale = Math.min(availableWidth / base.width, availableHeight / base.height);
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = pdfPage.getViewport({ scale: cssScale * pixelRatio });
        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`;
        canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`;
        const currentRender = pdfPage.render({ canvas, viewport });
        renderTask = currentRender;
        await currentRender.promise;
      } catch (error) {
        if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException")) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, page]);

  return (
    <div ref={frameRef} className="pdf-slide">
      {failed
        ? <a href={url} target="_blank" rel="noreferrer">{openLabel}</a>
        : <canvas ref={canvasRef} role="img" aria-label={title} />}
    </div>
  );
}
