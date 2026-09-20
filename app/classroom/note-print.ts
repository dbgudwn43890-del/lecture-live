/** Open printable disclosures, then restore only the ones printing changed. */
export function openNotePrintDetails(article: ParentNode) {
  const details = [...article.querySelectorAll<HTMLDetailsElement>(
    ".note-check-answer:not([open]), .note-check-hint:not([open]), .note-overview-details:not([open]), .note-diagram-details:not([open]), .answer-check details:not([open]), .note-original-answers[data-legacy='true']:not([open])",
  )];
  details.forEach(detail => { detail.open = true; });
  return () => { details.forEach(detail => { detail.open = false; }); };
}

/** The PDF button waits for the mounted note's async SVGs, not an arbitrary delay. */
export function waitForNoteDiagrams(article: ParentNode, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const pending = () => article.querySelector("[data-note-diagram-pending]");
  if (!pending()) return Promise.resolve(true);
  return new Promise(resolve => {
    const observer = new MutationObserver(() => { if (!pending()) finish(true); });
    const timer = setTimeout(() => finish(false), 5_000);
    const abort = () => finish(false);
    function finish(ready: boolean) {
      clearTimeout(timer); observer.disconnect(); signal.removeEventListener("abort", abort);
      resolve(ready);
    }
    observer.observe(article, { subtree: true, attributes: true, childList: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}
