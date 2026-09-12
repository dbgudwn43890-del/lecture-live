import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { mock, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { transformSync } from "next/dist/build/swc/index.js";

type Element = { type: unknown; props: Record<string, unknown> };
type Slot = { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void };
let slots: Slot[] = [], effects: Array<() => void> = [];
let cursor = 0;
let rerender = () => {};
registerHooks({
  load(url, context, nextLoad) {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (pathname.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: transformSync(readFileSync(new URL(url), "utf8"), {
      filename: pathname, module: { type: "es6" },
      jsc: { parser: { syntax: "typescript", tsx: true }, target: "es2022", transform: { react: { runtime: "automatic" } } },
    }).code };
    return nextLoad(url, context);
  },
});
mock.module("react", { namedExports: {
  useState(initial: unknown) {
    const slot = slots[cursor++] ??= { value: initial };
    return [slot.value, (update: unknown) => {
      const value = typeof update === "function" ? update(slot.value) : update;
      if (Object.is(value, slot.value)) return;
      slot.value = value; queueMicrotask(() => rerender());
    }];
  },
  useRef(initial: unknown) { return (slots[cursor++] ??= { value: { current: initial } }).value; },
  useEffect(callback: () => void | (() => void), dependencies: readonly unknown[]) {
    const slot = slots[cursor++] ??= {};
    if (slot.dependencies && dependencies.every((value, index) => Object.is(value, slot.dependencies![index]))) return;
    slot.dependencies = dependencies; effects.push(() => { slot.cleanup?.(); slot.cleanup = callback() || undefined; });
  },
} });
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
mock.module("react/jsx-runtime", { namedExports: { jsx, jsxs: jsx, Fragment: "fragment" } });
const { default: MaterialList } = await import("./material-list.tsx");
type Props = Parameters<typeof MaterialList>[0];
const DOCUMENT = "33333333-3333-4333-8333-333333333333";
const file = { id: DOCUMENT, filename: "Weighted average.txt", page_count: 2 };

function render(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(render);
  if (!value || typeof value !== "object" || !("props" in value)) return value;
  const element = value as Element;
  if (typeof element.type === "function") return render(element.type(element.props));
  return { ...element, props: { ...element.props, children: render(element.props.children) } };
}
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as Element;
  return [element, ...nodes(element.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "props" in value) return text((value as Element).props.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function invoke(element: Element, handler: string, event?: unknown) {
  const callback = element.props[handler];
  assert.equal(typeof callback, "function");
  return (callback as (event?: unknown) => unknown)(event);
}
const flush = async () => { await setImmediate(); };
function fixture(t: TestContext, props: Partial<Props> = {}, fetcher: typeof fetch = async () => Response.json({ status: "ready", preview: "The weighted average is 75." })) {
  let mounted = true;
  let tree: unknown;
  slots = []; cursor = 0; effects = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  rerender = () => {
    if (!mounted) return;
    cursor = 0; effects = [];
    tree = render(MaterialList({ documents: [file], locale: "en", onRemove() {}, onReplace() {}, ...props }));
    for (const effect of effects) effect();
  };
  rerender();
  t.after(async () => { mounted = false; for (const slot of slots) slot.cleanup?.(); await flush(); globalThis.fetch = originalFetch; });
  return { text: () => text(tree), all: () => nodes(tree),
    find(predicate: (element: Element) => boolean) { const node = nodes(tree).find(predicate); assert.ok(node); return node; },
  };
}

test("the collapsible list shows full filenames, reading completion, and PDF page versus text section counts", t => {
  const longName = "긴 강의 자료 제목 ".repeat(20) + ".pdf";
  const view = fixture(t, { locale: "ko", documents: [file, { id: "pdf", filename: longName, page_count: 7 }] });
  assert.equal(view.find(node => node.props.className === "lecture-material-list").props.open, false);
  assert.ok(view.text().includes(longName));
  assert.match(view.text(), /읽기 완료 · 2개 구간/);
  assert.match(view.text(), /읽기 완료 · 7쪽/);
  const summary = view.find(node => node.props.className === "lecture-material-list");
  invoke(summary, "onToggle", { currentTarget: { open: true } });
});

test("a pending replacement keeps the original document visible and names what is being read", t => {
  const view = fixture(t, { upload: { filename: "New slides.pdf", status: "pending", replacingId: DOCUMENT }, defaultOpen: true });
  assert.ok(view.text().includes("Weighted average.txt"));
  assert.ok(view.text().includes("New slides.pdf"));
  assert.match(view.text(), /The previous material stays available/);
  assert.equal(view.find(node => node.type === "input").props.disabled, true);
});

test("a failed upload names the file and the confirmed failure without hiding existing materials", t => {
  const failure = fixture(t, { upload: { filename: "Unreadable.pdf", status: "failed", error: "No readable text was found." } });
  assert.ok(failure.text().includes("Weighted average.txt"));
  assert.match(failure.text(), /Upload failed|No readable text was found/);
  assert.equal(failure.find(node => node.props.className === "material-upload-state").props.role, "alert");
});

test("preview fetch is lazy, localized, bounded by the API, and rendered as plain text", async t => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const dangerousText = '<img src=x onerror="steal()"> is literal source text.';
  const view = fixture(t, { locale: "ko" }, async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ status: "ready", preview: dangerousText }); });
  assert.equal(calls.length, 0);
  invoke(view.find(node => node.props.className === "material-text-preview"), "onToggle", { currentTarget: { open: true } });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/materials?documentId=${DOCUMENT}&preview=text`);
  assert.equal(new Headers(calls[0].init?.headers).get("x-site-locale"), "ko");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(view.find(node => node.props.className === "material-preview-text").props.children, dangerousText);
  assert.ok(!view.all().some(node => node.type === "img" || node.props.dangerouslySetInnerHTML));
});

test("a failed preview offers retry without marking the material missing or leaking the response", async t => {
  let requests = 0;
  const view = fixture(t, {}, async () => ++requests === 1 ? Response.json({ error: "private upstream body" }, { status: 503 }) : Response.json({ status: "empty", preview: "" }));
  invoke(view.find(node => node.props.className === "material-text-preview"), "onToggle", { currentTarget: { open: true } });
  await flush();
  assert.match(view.text(), /Could not load the preview/);
  assert.doesNotMatch(view.text(), /private upstream body/);
  invoke(view.find(node => node.type === "button" && text(node) === "Try again"), "onClick");
  await flush();
  assert.equal(requests, 2);
  assert.match(view.text(), /Text not confirmed/);
  assert.match(view.text(), /No readable text was found in the stored index/);
});

test("remove and replacement callbacks receive the chosen document and file only", async t => {
  const actions: unknown[] = [];
  const chosen = new File(["new text"], "Replacement.txt");
  const view = fixture(t, { onRemove: id => { actions.push(["remove", id]); }, onReplace: (id, file) => { actions.push(["replace", id, file]); } });
  invoke(view.find(node => node.type === "input"), "onChange", { target: { files: [chosen], value: "old" } });
  await flush();
  assert.deepEqual(actions, [["replace", DOCUMENT, chosen]]);
  invoke(view.find(node => node.type === "button" && text(node) === "Remove"), "onClick");
  await flush();
  assert.deepEqual(actions, [["replace", DOCUMENT, chosen], ["remove", DOCUMENT]]);
});

test("a full lecture explains safe replacement capacity before opening a file picker", async t => {
  let replaced = false;
  const view = fixture(t, { documents: Array.from({ length: 20 }, (_, index) => ({ ...file, id: String(index) })), onReplace() { replaced = true; } });
  assert.match(view.text(), /All 20 material slots are occupied/);
  const input = view.find(node => node.type === "input");
  assert.equal(input.props.disabled, true);
  invoke(input, "onChange", { target: { files: [new File(["text"], "replacement.txt")], value: "" } });
  await flush();
  assert.equal(replaced, false);
});
