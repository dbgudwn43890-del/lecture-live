import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createMaterialPdfRenderer } from "./material-pdf.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await setImmediate(); };

function fixture(t: TestContext, delayImport = false) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: Array<ReturnType<typeof deferred<Response>> & { signal: AbortSignal }> = [];
  const loads: Array<ReturnType<typeof deferred<unknown>> & { destroys: number }> = [];
  const pages: Array<ReturnType<typeof deferred<unknown>> & { number: number }> = [];
  const renders: Array<ReturnType<typeof deferred<void>> & { cancels: number }> = [];
  const events: string[] = [];
  const pdf = { getPage(number: number) { const result = { ...deferred<unknown>(), number }; pages.push(result); return result.promise; } };
  const page = { getViewport: () => ({ width: 1200, height: 1600 }), render() {
    const result = { ...deferred<void>(), cancels: 0 };
    renders.push(result);
    return { promise: result.promise, cancel() { result.cancels++; events.push("cancel"); result.reject(new Error("Rendering cancelled")); } };
  } };
  const pdfjs = { version: "test", GlobalWorkerOptions: { workerSrc: "" }, getDocument() {
    const result = { ...deferred<unknown>(), destroys: 0 };
    loads.push(result);
    return { promise: result.promise, async destroy() { result.destroys++; events.push("destroy"); result.reject(new Error("Loading cancelled")); } };
  } };
  type PdfJs = Awaited<ReturnType<NonNullable<Parameters<typeof createMaterialPdfRenderer>[1]>>>;
  const imported = deferred<PdfJs>();
  if (!delayImport) imported.resolve(pdfjs as unknown as PdfJs);
  let errors = 0, imports = 0;
  const renderer = createMaterialPdfRenderer((async (_url, init) => {
    const result = { ...deferred<Response>(), signal: init?.signal as AbortSignal };
    requests.push(result); return result.promise;
  }) as typeof fetch, () => { imports++; return imported.promise; });
  const stops: Array<() => void> = [];
  const canvas = () => ({ width: 0, height: 0, getContext: () => ({}) }) as unknown as HTMLCanvasElement;
  const expire = async () => { t.mock.timers.tick(0); await flush(); };
  t.after(async () => { stops.forEach(stop => stop()); await expire(); });
  return { requests, loads, pages, renders, events, pdf, page, pdfjs, imported, canvas, expire,
    get errors() { return errors; }, get imports() { return imports; },
    start(id = "document", number = 1, target = canvas()) {
      const stop = renderer(id, number, target, () => { errors++; }); stops.push(stop); return stop;
    },
    async fetched(index = 0) { requests[index].resolve(Response.json({ url: "https://storage.example/signed.pdf" })); await flush(); },
    async loaded(index = 0) { loads[index].resolve(pdf); await flush(); },
    async drawn(index = 0) { pages[index].resolve(page); await flush(); renders[index].resolve(); await flush(); },
  };
}

test("pages share one document until the final consumer leaves; completed canvases remain printable", async t => {
  const f = fixture(t), canvas = f.canvas();
  const first = f.start("same", 1, canvas), second = f.start("same", 2);
  assert.equal(f.requests.length, 1);
  await f.fetched(); await f.loaded();
  assert.equal(f.loads.length, 1);
  assert.deepEqual(f.pages.map(page => page.number), [1, 2]);
  await f.drawn(0); await f.drawn(1);
  first(); first(); await f.expire();
  assert.equal(f.loads[0].destroys, 0);
  assert.equal(f.requests[0].signal.aborted, false);
  second(); await f.expire();
  assert.equal(f.loads[0].destroys, 1);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.deepEqual([canvas.width, canvas.height], [1200, 1600]);
  assert.equal(f.errors, 0);
});

test("Strict Mode cleanup and immediate setup reuse the pending download and only draw the live page", async t => {
  const f = fixture(t), canvas = f.canvas();
  f.start("same", 1, canvas)();
  const stop = f.start("same", 1, canvas);
  await f.expire();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal.aborted, false);
  await f.fetched(); await f.loaded(); await f.drawn();
  assert.equal(f.pages.length, 1);
  stop(); await f.expire();
  assert.equal(f.loads[0].destroys, 1);
});

test("reopening a released document fetches a fresh signed URL and loading task", async t => {
  const f = fixture(t), stop = f.start();
  await f.fetched(); await f.loaded(); await f.drawn();
  stop(); await f.expire();
  f.start(); await f.fetched(1); await f.loaded(1); await f.drawn(1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.loads.length, 2);
  assert.equal(f.loads[0].destroys, 1);
  assert.equal(f.loads[1].destroys, 0);
});

test("closing during the signed URL request aborts it and ignores even a late successful response", async t => {
  const f = fixture(t), stop = f.start();
  stop(); await f.expire(); await f.fetched();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.imports, 0);
  assert.equal(f.loads.length, 0);
  assert.equal(f.errors, 0);
});

test("closing while PDF.js imports does not start a worker when the import later resolves", async t => {
  const f = fixture(t, true), stop = f.start();
  await f.fetched(); stop(); await f.expire();
  f.imported.resolve(f.pdfjs as unknown as Awaited<typeof f.imported.promise>); await flush();
  assert.equal(f.imports, 1);
  assert.equal(f.loads.length, 0);
  assert.equal(f.errors, 0);
});

test("closing during PDF download destroys its loading task without reporting a preview failure", async t => {
  const f = fixture(t), stop = f.start();
  await f.fetched(); stop(); await f.expire();
  assert.equal(f.loads[0].destroys, 1);
  assert.equal(f.pages.length, 0);
  assert.equal(f.errors, 0);
});

test("closing while getPage is pending never renders a late page", async t => {
  const f = fixture(t), stop = f.start();
  await f.fetched(); await f.loaded(); stop(); await f.expire();
  f.pages[0].resolve(f.page); await flush();
  assert.equal(f.renders.length, 0);
  assert.equal(f.loads[0].destroys, 1);
  assert.equal(f.errors, 0);
});

test("an in-progress render is cancelled before the final document is destroyed", async t => {
  const f = fixture(t), stop = f.start();
  await f.fetched(); await f.loaded(); f.pages[0].resolve(f.page); await flush();
  stop(); stop(); await f.expire();
  assert.equal(f.renders[0].cancels, 1);
  assert.deepEqual(f.events, ["cancel", "destroy"]);
  assert.equal(f.errors, 0);
});

test("a failed load is destroyed and retryable; releasing the failed consumer cannot evict its replacement", async t => {
  const f = fixture(t), failed = f.start();
  await f.fetched(); f.loads[0].reject(new Error("Invalid PDF")); await flush();
  assert.equal(f.errors, 1);
  assert.equal(f.loads[0].destroys, 1);
  f.start(); await f.fetched(1); await f.loaded(1);
  failed(); await f.expire(); f.start("document", 2);
  assert.equal(f.requests.length, 2);
  assert.equal(f.loads[1].destroys, 0);
});

test("different documents are released independently when switching lectures", async t => {
  const f = fixture(t), first = f.start("first");
  f.start("second"); await f.fetched(0); await f.fetched(1); await f.loaded(0); await f.loaded(1);
  first(); await f.expire();
  assert.equal(f.loads[0].destroys, 1);
  assert.equal(f.loads[1].destroys, 0);
});
