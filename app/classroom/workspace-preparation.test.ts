import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { mock, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { transformSync } from "next/dist/build/swc/index.js";

type Element = { type: unknown; props: Record<string, unknown> };
type Slot = { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void };
let slots: Slot[] = [];
let cursor = 0;
let effects: Array<() => void> = [];
let rerender = () => {};
const noop = () => {};
const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      for (const extension of [".ts", ".tsx", ".js"]) {
        try { return nextResolve(`${specifier}${extension}`, context); } catch {}
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (new URL(url).pathname.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (new URL(url).pathname.endsWith(".tsx")) return { format: "module", shortCircuit: true,
      source: transformSync(readFileSync(new URL(url), "utf8"), {
        filename: new URL(url).pathname, module: { type: "es6" },
        jsc: { parser: { syntax: "typescript", tsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      }).code };
    return nextLoad(url, context);
  },
});
// Run the real workspace and its JSX callbacks. Capture/DOM-only child hooks
// are replaced; state, effects, refs, network responses, and timer order remain
// observable rather than testing a second copy of the preparation logic.
mock.module("react", { namedExports: {
  useState(initial: unknown) {
    const slot = slots[cursor++] ??= { value: typeof initial === "function" ? initial() : initial };
    return [slot.value, (update: unknown) => {
      const value = typeof update === "function" ? update(slot.value) : update;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      queueMicrotask(() => rerender());
    }];
  },
  useRef(initial: unknown) { return (slots[cursor++] ??= { value: { current: initial } }).value; },
  useMemo(create: () => unknown, dependencies: readonly unknown[]) {
    const slot = slots[cursor++] ??= {};
    if (!same(slot.dependencies, dependencies)) { slot.dependencies = dependencies; slot.value = create(); }
    return slot.value;
  },
  useEffect(callback: () => void | (() => void), dependencies?: readonly unknown[]) {
    const slot = slots[cursor++] ??= {};
    if (same(slot.dependencies, dependencies)) return;
    slot.dependencies = dependencies;
    effects.push(() => { slot.cleanup?.(); slot.cleanup = callback() || undefined; });
  },
} });
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
mock.module("react/jsx-runtime", { namedExports: { jsx, jsxs: jsx, Fragment: "fragment" } });
const icons = "ArrowDown ArrowUp BookOpen ChevronLeft ChevronRight CreditCard LogOut Mic MonitorPlay MoreHorizontal MoreVertical PanelLeft Paperclip Plus Search Settings2 Smartphone Upload X".split(" ");
mock.module("lucide-react", { namedExports: Object.fromEntries(icons.map(name => [name, name])) });
mock.module(pathToFileURL("node_modules/next/dynamic.js").href, { defaultExport: () => "dynamic-child" });
mock.module(pathToFileURL("node_modules/next/link.js").href, { defaultExport: "link" });
mock.module("@dnd-kit/react", { namedExports: { DragDropProvider: "drag-provider", useDraggable: () => ({}), useDroppable: () => ({}) } });
for (const file of ["workspace-dialog", "listening-indicator", "microphone-switch", "language-choices", "lecture-preview", "note-language-picker", "recording-preparation", "material-list"]) {
  mock.module(pathToFileURL(`app/classroom/${file}.tsx`).href, { defaultExport: file });
}
mock.module(pathToFileURL("app/credit-usage.tsx").href, { defaultExport: "credit-usage" });
mock.module(pathToFileURL("app/classroom/note-generation.tsx").href, { namedExports: { NoteGenerationIcon: "note-icon" } });
const emptyAnswers: unknown[] = [];
const hookMocks = {
  "use-online-layout": { useOnlineLayout: () => ({ panesRef: { current: null } }) },
  "use-conversation-scroll": { useConversationScroll: () => ({ messagesScrollRef: { current: null }, isFollowingLatest: true, jumpToLatest: noop }) },
  "use-lecture-note": { useLectureNote: () => ({ phase: "idle" }) },
  "use-note-language": { useNoteLanguage: () => ({ preference: "system", language: "ko", systemLanguage: "ko", change: noop }) },
  "use-live-assist": { useLiveAssist: () => ({ answers: emptyAnswers }) },
  "use-live-script": { useLiveScript: () => ({}) },
};
for (const [file, namedExports] of Object.entries(hookMocks)) mock.module(pathToFileURL(`app/classroom/${file}.ts`).href, { namedExports });
mock.module(pathToFileURL("app/lib/use-payment-return.ts").href, { namedExports: { usePaymentReturn: noop } });
class MockAudioTransferError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }
const transfers: Array<{ file: File; transfer: unknown; signal?: AbortSignal }> = [];
let transferFailure: Error | null = null;
mock.module(pathToFileURL("app/classroom/audio-transfer.ts").href, { namedExports: {
  AudioTransferError: MockAudioTransferError,
  transferRecording: async (file: File, transfer: unknown, progress: (percent: number) => void, signal?: AbortSignal) => {
    transfers.push({ file, transfer, signal });
    if (transferFailure) throw transferFailure;
    progress(100);
  },
} });

type RecorderOptions = { setActiveSessionId(id: string): void; setLectureTitle(title: string): void; clearMessages(): void };
let recorder: ReturnType<typeof fakeRecorder>;
let completeStart: (id: string, title: string) => void = noop;
function fakeRecorder() {
  const ref = <T,>(current: T) => ({ current });
  return {
    status: "idle", elapsedMs: 0, segments: [] as unknown[], interim: "", inputSource: "microphone", phoneInput: false,
    isFinalizing: false, isPausing: false, isSwitchingMicrophone: false,
    meterRef: ref(null), segmentsRef: ref<unknown[]>([]), segmentIdsRef: ref(new Set()), confirmedSegmentIdsRef: ref(new Set()),
    activeSessionIdRef: ref(""), finishingRef: ref(false), saveFailuresRef: ref(0), elapsedBaseMsRef: ref(0), startedAtRef: ref(0), streamOffsetMsRef: ref(0),
    setStatus(value: string) { recorder.status = value; queueMicrotask(() => rerender()); },
    setElapsedMs(value: number) { recorder.elapsedMs = value; queueMicrotask(() => rerender()); },
    setSegments(value: unknown[]) { recorder.segments = value; queueMicrotask(() => rerender()); },
    showInterim(value: string) { recorder.interim = value; queueMicrotask(() => rerender()); },
    restoreInputSource: noop, flushUtterance: noop, pauseLecture: noop, resumeLecture: noop, finishLecture: noop, stopLecture: noop,
  };
}
mock.module(pathToFileURL("app/classroom/use-lecture-recorder.ts").href, { namedExports: {
  MAX_LECTURE_MS: 10_800_000,
  useLectureRecorder(options: RecorderOptions) {
    return { ...recorder, startLecture() {
      recorder.status = "connecting";
      completeStart = (id, title) => {
        options.setActiveSessionId(id);
        recorder.activeSessionIdRef.current = id;
        options.setLectureTitle(title);
        options.clearMessages();
        recorder.status = "recording";
        queueMicrotask(() => rerender());
      };
      queueMicrotask(() => rerender());
    } };
  },
} });
const { default: LectureWorkspace } = await import("./workspace-client.tsx");

const SESSION = "11111111-1111-4111-8111-111111111111";
const documentRow = { id: "material-1", session_id: SESSION, classroom_id: null, filename: "weighted-average.txt", page_count: 1 };
const sessionRow = (title: string, id = SESSION) => ({ id, title, classroom_id: null, status: "draft" as const, duration_seconds: 0, recorded_ms: 0, question_count: 0, started_at: "2026-09-11T00:00:00Z" });
const flush = async () => { await setImmediate(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function descendants(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as Element;
  return [element, ...descendants(element.props.children)];
}
function visibleText(value: unknown): string {
  if (Array.isArray(value)) return value.map(visibleText).join("");
  if (value && typeof value === "object" && "props" in value) return visibleText((value as Element).props.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function invoke(element: Element, handler: string, event?: unknown) {
  const callback = element.props[handler];
  assert.equal(typeof callback, "function", `Expected ${handler}`);
  return (callback as (event?: unknown) => unknown)(event);
}
type RequestCall = { url: string; method: string; body: Record<string, unknown>; form?: FormData };
type Handler = (call: RequestCall) => Response | Promise<Response> | undefined;
function fixture(t: TestContext, handler?: Handler) {
  slots = []; cursor = 0; effects = []; recorder = fakeRecorder();
  transfers.length = 0; transferFailure = null;
  let mounted = true;
  let tree: unknown;
  const calls: RequestCall[] = [];
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const memory = new Map<string, string>();
  const environment = {
    window: { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: noop, removeEventListener: noop,
      location: { href: "https://lecue.test/classroom", search: "" }, history: { replaceState: noop },
      localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } },
    document: { addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [],
      createElement(tag: string) {
        assert.equal(tag, "audio", "only browser audio metadata probing is mocked");
        return { duration: 30, onloadedmetadata: null as null | (() => void), set src(_value: string) { queueMicrotask(() => this.onloadedmetadata?.()); } };
      },
    }, navigator: {},
    fetch: async (input: string, init: RequestInit = {}) => {
      const form = init.body instanceof FormData ? init.body : undefined;
      const call = { url: String(input), method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : {}, form };
      calls.push(call);
      const custom = handler?.(call);
      if (custom) return custom;
      if (call.url === "/api/lecture-audio") return Response.json({ uploads: [], availability: { available: false, maxFileBytes: 4_000_000 } });
      if (call.url === "/api/consents") return Response.json({ satisfied: true });
      if (call.url === "/api/llm-credentials") return Response.json({ credentials: [] });
      if (call.url === "/api/classrooms") return Response.json({ classrooms: [], unassignedSessions: [] });
      if (call.url === "/api/materials" && call.method === "POST") return Response.json({ document: documentRow }, { status: 201 });
      if (call.url.startsWith("/api/materials?")) return Response.json({ documents: [] });
      if (call.body.action === "draft") return Response.json({ session: sessionRow(String(call.body.title)) });
      if (call.url === "/api/ask") return new Response(JSON.stringify({ done: { answer: "The weighted average is 75.", sources: [], materialSources: [] } }) + "\n");
      if (call.url.startsWith("/api/lecture-sessions?")) return Response.json({ session: sessionRow("Restored", new URL(call.url, "https://lecue.test").searchParams.get("sessionId")!), segments: [], questions: [] });
      return Response.json({ reconciled: 0 });
    },
  };
  const original = Object.keys(environment).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(environment)) Object.defineProperty(globalThis, key, { configurable: true, value });
  rerender = () => {
    if (!mounted) return;
    cursor = 0; effects = [];
    tree = LectureWorkspace({ locale: "en", initial: { profile: null, classrooms: [], unassignedSessions: [], creditStatus: null } });
    for (const effect of effects) effect();
  };
  rerender();
  t.after(async () => {
    mounted = false;
    for (const slot of slots) slot.cleanup?.();
    await flush();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const find = (predicate: (element: Element) => boolean) => {
    const element = descendants(tree).find(predicate);
    assert.ok(element, "Expected element was not rendered");
    return element;
  };
  return { calls, find, all: () => descendants(tree),
    title: () => find(element => element.type === "input" && element.props["aria-label"] === "Lecture name"),
    composer: () => find(element => element.type === "textarea" && element.props.id === "question"),
    async typeTitle(value: string) { invoke(this.title(), "onChange", { target: { value } }); await flush(); },
    async upload() {
      const input = find(element => element.type === "input" && element.props.type === "file" && String(element.props.accept).includes(".txt"));
      invoke(input, "onChange", { target: { files: [new File(["10 × 90 + 30 × 70"], "weighted-average.txt")], value: "" } });
      await flush();
    },
    async tick(ms: number) { t.mock.timers.tick(ms); await flush(); },
    text: () => visibleText(tree),
  };
}

test("material upload creates the draft with the entered title and keeps newer typing through delayed saves", async t => {
  const created = deferred<Response>();
  const firstRename = deferred<Response>();
  let renameCount = 0;
  const view = fixture(t, call => call.body.action === "draft" ? created.promise
    : call.body.action === "rename" && ++renameCount === 1 ? firstRename.promise : undefined);
  await flush();
  await view.typeTitle("My weighted-average lecture");
  await view.upload();
  assert.equal(view.calls.find(call => call.body.action === "draft")?.body.title, "My weighted-average lecture");
  await view.typeTitle("Changed while creating");
  created.resolve(Response.json({ session: sessionRow("My weighted-average lecture") }));
  await flush();
  assert.equal(view.title().props.value, "Changed while creating");
  await view.typeTitle("Final lecture title");
  await view.tick(600);
  assert.deepEqual(view.calls.filter(call => call.body.action === "rename").map(call => call.body.title), ["Changed while creating"]);
  firstRename.resolve(Response.json({ saved: true }));
  await flush();
  assert.deepEqual(view.calls.filter(call => call.body.action === "rename").map(call => call.body.title), ["Changed while creating", "Final lecture title"]);
  assert.equal(view.title().props.value, "Final lecture title");
  assert.equal(view.composer().props.disabled, false);
});

test("a finished material upload enables the ordinary composer and a late empty GET cannot erase it", async t => {
  const loaded = deferred<Response>();
  const view = fixture(t, call => call.url.startsWith("/api/materials?") ? loaded.promise : undefined);
  await flush();
  assert.equal(view.composer().props.disabled, true);
  assert.equal(view.find(element => element.props.className === "conversation-materials").props.open, false);
  await view.typeTitle("Materials only");
  await view.upload();
  assert.equal(view.composer().props.disabled, false);
  assert.equal(view.find(element => element.props.className === "conversation-materials").props.open, true, "the uploaded filename and preview controls are immediately visible");
  invoke(view.find(element => element.props.className === "conversation-materials"), "onToggle", { currentTarget: { open: false } });
  await flush();
  assert.equal(view.find(element => element.props.className === "conversation-materials").props.open, false, "the learner can close the automatically opened list");
  loaded.resolve(Response.json({ documents: [] }));
  await flush();
  assert.equal(view.composer().props.disabled, false);
  invoke(view.composer(), "onChange", { target: { value: "Explain the weighted average" } });
  await flush();
  invoke(view.find(element => element.type === "form" && element.props.className === "question-form"), "onSubmit", { preventDefault: noop });
  await flush();
  const question = view.calls.find(call => call.url === "/api/ask");
  assert.ok(question);
  assert.equal(question.body.lectureSessionId, SESSION);
  assert.deepEqual(question.body.segments, []);
  assert.equal(question.body.mode, undefined);
  assert.ok(view.text().includes("Explain the weighted average"));
});

test("starting a material draft retains its question and the title edited during microphone setup", async t => {
  const view = fixture(t);
  await flush();
  await view.typeTitle("Prepared lecture");
  await view.upload();
  invoke(view.composer(), "onChange", { target: { value: "Keep this material question" } });
  await flush();
  invoke(view.find(element => element.type === "form" && element.props.className === "question-form"), "onSubmit", { preventDefault: noop });
  await flush();
  invoke(view.find(element => element.type === "button" && visibleText(element) === "In-person lecture"), "onClick");
  await flush();
  assert.equal(recorder.status, "connecting");
  await view.typeTitle("Edited while connecting");
  completeStart(SESSION, "Prepared lecture");
  await flush();
  assert.equal(view.title().props.value, "Edited while connecting");
  assert.ok(view.text().includes("Keep this material question"));
  assert.equal(view.calls.filter(call => call.body.action === "rename").at(-1)?.body.title, "Edited while connecting");
});

test("an unfinished or failed material upload keeps the question composer disabled", async t => {
  const upload = deferred<Response>();
  const view = fixture(t, call => call.url === "/api/materials" && call.method === "POST" ? upload.promise : undefined);
  await flush();
  await view.upload();
  assert.equal(view.composer().props.disabled, true);
  upload.resolve(Response.json({ error: "This material has no readable text." }, { status: 422 }));
  await flush();
  assert.equal(view.composer().props.disabled, true);
  assert.ok(view.text().includes("This material has no readable text."));
});

test("navigation saves the latest title before resetting and blocks a recording start during that save", async t => {
  const saved = deferred<Response>();
  const view = fixture(t, call => call.body.action === "rename" ? saved.promise : undefined);
  await flush();
  await view.typeTitle("Initial title");
  await view.upload();
  await view.typeTitle("Latest title before leaving");
  const start = view.find(element => element.type === "button" && visibleText(element) === "In-person lecture");
  invoke(view.find(element => element.props["aria-label"] === "New lecture"), "onClick");
  invoke(start, "onClick"); // Deliberately before rerender: the ref must guard it.
  await flush();
  assert.equal(recorder.status, "idle");
  assert.equal(recorder.activeSessionIdRef.current, SESSION);
  assert.equal(view.title().props.value, "Latest title before leaving");
  assert.equal(view.title().props.disabled, true);
  assert.equal(view.find(element => element.type === "button" && visibleText(element) === "In-person lecture").props.disabled, true);
  assert.equal(view.calls.filter(call => call.body.action === "rename").at(-1)?.body.title, "Latest title before leaving");
  saved.resolve(Response.json({ saved: true }));
  await flush();
  assert.equal(view.title().props.value, "");
  assert.equal(recorder.activeSessionIdRef.current, "");
  assert.equal(view.composer().props.disabled, true, "a new lecture must not inherit the previous materials");
  assert.equal(view.find(element => element.props.className === "conversation-materials").props.open, false, "a new lecture starts with the previous material list closed");
});

test("renaming the active lecture in the sidebar updates the title later saved on navigation", async t => {
  const view = fixture(t);
  await flush();
  await view.typeTitle("Old name");
  await view.upload();
  invoke(view.find(element => element.type === "button" && visibleText(element) === "Rename"), "onClick", { currentTarget: { closest: () => null } });
  await flush();
  invoke(view.find(element => element.props.className === "sidebar-session-rename"), "onBlur", { target: { value: "Renamed in sidebar" } });
  await flush();
  assert.equal(view.title().props.value, "Renamed in sidebar");
  invoke(view.find(element => element.props["aria-label"] === "New lecture"), "onClick");
  await flush();
  const writes = view.calls.filter(call => call.body.action === "rename");
  assert.ok(writes.length > 0);
  assert.ok(writes.every(call => call.body.title === "Renamed in sidebar"));
});

test("deleting the active lecture resets it without racing a title save against deletion", async t => {
  const view = fixture(t, call => call.body.action === "rename" ? Response.json({ error: "The lecture is deleted." }, { status: 404 }) : undefined);
  await flush();
  await view.typeTitle("Delete me");
  await view.upload();
  invoke(view.find(element => element.props.className === "session-menu-delete"), "onClick", { currentTarget: { closest: () => null } });
  await flush();
  invoke(view.find(element => element.props.className === "confirm-delete"), "onClick");
  await flush();
  assert.equal(view.calls.filter(call => call.body.action === "rename").length, 0);
  assert.ok(view.calls.some(call => call.method === "DELETE" && call.url.includes(SESSION)));
  assert.equal(recorder.activeSessionIdRef.current, "");
  assert.equal(view.title().props.value, "");
  assert.equal(view.composer().props.disabled, true);
});

test("unavailable recording uploads stop the file picker before the learner chooses a file", async t => {
  const view = fixture(t);
  await flush();
  const input = view.find(element => element.type === "input" && element.props.type === "file" && String(element.props.accept).includes(".wav"));
  assert.equal(input.props.disabled, true);
  let prevented = false;
  invoke(input, "onClick", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(view.text().includes("Recording uploads are currently unavailable on our service."));
  assert.equal(view.calls.filter(call => call.url === "/api/lecture-audio" && call.method === "POST").length, 0);
});

test("preparation passes the selected language and stops the local sound check before recording starts", async t => {
  const view = fixture(t);
  await flush();
  const preparation = view.find(element => element.type === "recording-preparation");
  assert.equal(preparation.props.english, true);
  assert.equal(preparation.props.enabled, true);
  assert.equal(typeof preparation.props.language, "string");
  assert.ok(String(preparation.props.language).length > 0);
  let stopped = false;
  (preparation.props.stopRef as { current: () => void }).current = () => { stopped = true; };
  invoke(view.find(element => element.type === "button" && visibleText(element) === "In-person lecture"), "onClick");
  assert.equal(stopped, true);
  assert.equal(recorder.status, "connecting");
});

test("the material list keeps the original until its replacement upload completes", async t => {
  const ready = deferred<Response>();
  let uploads = 0;
  const view = fixture(t, call => call.url === "/api/materials" && call.method === "POST" && ++uploads === 2 ? ready.promise : undefined);
  await flush();
  await view.upload();
  const list = () => view.find(element => element.type === "material-list" && (element.props.documents as unknown[]).length > 0);
  const replace = list().props.onReplace as (id: string, file: File) => Promise<boolean>;
  const replacing = replace(documentRow.id, new File(["replacement body"], "replacement.txt"));
  await flush();
  assert.deepEqual((list().props.documents as Array<{ id: string }>).map(document => document.id), [documentRow.id]);
  assert.equal((list().props.upload as { status: string }).status, "pending");
  assert.equal(view.calls.filter(call => call.method === "DELETE").length, 0);
  ready.resolve(Response.json({ document: { ...documentRow, id: "material-2", filename: "replacement.txt" } }, { status: 201 }));
  assert.equal(await replacing, true);
  await flush();
  assert.deepEqual((list().props.documents as Array<{ id: string }>).map(document => document.id), ["material-2"]);
  assert.ok(view.calls.some(call => call.method === "DELETE" && call.url.includes(documentRow.id)));
});

test("failed old-file removal after replacement retains both known documents and explains the result", async t => {
  let uploads = 0;
  const view = fixture(t, call => call.method === "DELETE" && call.url.startsWith("/api/materials?")
    ? Response.json({ error: "Removal failed" }, { status: 503 })
    : call.url === "/api/materials" && call.method === "POST" && ++uploads === 2
      ? Response.json({ document: { ...documentRow, id: "replacement", filename: "replacement.txt" } }, { status: 201 }) : undefined);
  await flush();
  await view.upload();
  const list = () => view.find(element => element.type === "material-list" && (element.props.documents as unknown[]).length > 0);
  await (list().props.onReplace as (id: string, file: File) => Promise<boolean>)(documentRow.id, new File(["replacement"], "replacement.txt"));
  await flush();
  assert.deepEqual((list().props.documents as Array<{ id: string }>).map(document => document.id), ["replacement", documentRow.id]);
  assert.match(view.text(), /Both files are kept/);
});

test("search has a recovery action and lecture rows display date, status, and question count", async t => {
  const view = fixture(t);
  await flush();
  await view.typeTitle("Weighted average class");
  await view.upload();
  const metadata = view.find(element => element.props.className === "sidebar-session-details");
  assert.match(visibleText(metadata), /Sep 11/);
  assert.match(visibleText(metadata), /Not started/);
  assert.match(visibleText(metadata), /0 questions/);
  invoke(view.find(element => element.type === "button" && element.props["aria-label"] === "Search lectures" && element.props["aria-expanded"] === false), "onClick");
  await flush();
  invoke(view.find(element => element.type === "input" && element.props.type === "search"), "onChange", { target: { value: "missing lecture" } });
  await flush();
  assert.match(view.text(), /No lectures match “missing lecture”/);
  invoke(view.find(element => element.type === "button" && visibleText(element) === "Clear search"), "onClick");
  await flush();
  assert.equal(view.find(element => element.type === "input" && element.props.type === "search").props.value, "");
  assert.ok(view.all().some(element => element.props.className === "sidebar-session-details"));
});

test("long questions expose a live count at 800 characters and explain the 1000-character limit", async t => {
  const view = fixture(t);
  await flush();
  await view.upload();
  for (const length of [799, 800, 1000]) {
    invoke(view.composer(), "onChange", { target: { value: "a".repeat(length) } });
    await flush();
    const counter = view.all().find(element => element.props.id === "question-length");
    if (length === 799) assert.equal(counter, undefined);
    else {
      assert.ok(counter);
      assert.equal(counter.props.role, "status");
      assert.equal(view.composer().props["aria-describedby"], "question-length");
      assert.ok(visibleText(counter).includes(`${length.toLocaleString("en-US")} / 1,000`));
      if (length === 1000) assert.match(visibleText(counter), /Attach longer content as a material/);
    }
  }
});

test("the same topbar settings control remains available during preparation and after a lecture ends", async t => {
  const view = fixture(t);
  await flush();
  const settings = () => view.find(element => element.type === "button" && element.props.className === "online-settings-button");
  assert.equal(settings().props["aria-label"], "Settings");
  invoke(settings(), "onClick");
  await flush();
  invoke(view.find(element => element.type === "workspace-dialog" && element.props.label === "Settings"), "onClose");
  recorder.setStatus("ended");
  await flush();
  assert.equal(settings().props["aria-label"], "Settings");
  invoke(settings(), "onClick");
  await flush();
  assert.ok(view.find(element => element.type === "workspace-dialog" && element.props.label === "Settings"));
});

const audioRow = { id: "audio-upload", session_id: SESSION, filename: "recording.wav", status: "uploading" };
const audioTransfer = { endpoint: "https://storage.example/storage/v1/upload/resumable", bucketName: "lecture-audio", objectName: "owner/recording.wav", token: "scoped-token", contentType: "audio/wav" };
function allowAudio(call: RequestCall) {
  return call.url === "/api/lecture-audio" && call.method === "GET"
    ? Response.json({ uploads: [], availability: { available: true, reason: null, maxFileBytes: 200 * 1024 * 1024 } }) : undefined;
}
async function chooseAudio(view: ReturnType<typeof fixture>) {
  const input = view.find(element => element.type === "input" && element.props.type === "file" && String(element.props.accept).includes(".wav"));
  assert.equal(input.props.disabled, false);
  invoke(input, "onChange", { target: { files: [new File(["recording bytes"], "recording.wav", { type: "audio/wav", lastModified: 100 })], value: "" } });
  for (let index = 0; index < 20; index++) await flush();
}

test("recording upload prepares a scoped transfer then completes through JSON without sending the file to Next", async t => {
  const view = fixture(t, call => allowAudio(call) ?? (call.url === "/api/lecture-audio" && call.body.action === "prepare"
    ? Response.json({ upload: audioRow, transfer: audioTransfer })
    : call.url === "/api/lecture-audio" && call.body.action === "complete" ? Response.json({ upload: { ...audioRow, status: "processing" } }) : undefined));
  await flush();
  await view.typeTitle("My recorded lecture");
  await chooseAudio(view);
  const controls = view.calls.filter(call => call.url === "/api/lecture-audio" && call.method === "POST");
  assert.deepEqual(controls.map(call => call.body.action), ["prepare", "complete"]);
  assert.equal(controls[0].body.title, "My recorded lecture");
  assert.equal(controls[0].body.filename, "recording.wav");
  assert.equal(controls[1].body.uploadId, audioRow.id);
  assert.ok(controls.every(call => !call.form));
  assert.equal(transfers.length, 1);
  assert.deepEqual(transfers[0].transfer, audioTransfer);
  assert.ok(transfers[0].signal instanceof AbortSignal);
  assert.match(view.text(), /Transcribing\. You can leave this page/);
});

test("an already uploaded file completes without transferring its bytes again", async t => {
  const view = fixture(t, call => allowAudio(call) ?? (call.body.action === "prepare"
    ? Response.json({ upload: audioRow, readyToComplete: true })
    : call.body.action === "complete" ? Response.json({ upload: { ...audioRow, status: "processing" } }) : undefined));
  await flush();
  await chooseAudio(view);
  assert.equal(transfers.length, 0);
  assert.deepEqual(view.calls.filter(call => call.url === "/api/lecture-audio" && call.method === "POST").map(call => call.body.action), ["prepare", "complete"]);
});

test("pending server verification is retried before showing the transcription completion notice", async t => {
  let completions = 0;
  const view = fixture(t, call => allowAudio(call) ?? (call.body.action === "prepare"
    ? Response.json({ upload: audioRow, readyToComplete: true })
    : call.body.action === "complete" ? Response.json(++completions === 1 ? { upload: audioRow, pending: true } : { upload: { ...audioRow, status: "processing" } }) : undefined));
  await flush();
  await chooseAudio(view);
  assert.equal(completions, 1);
  assert.doesNotMatch(view.text(), /Transcribing\. You can leave this page/);
  await view.tick(5_000);
  assert.equal(completions, 2);
  assert.match(view.text(), /Transcribing\. You can leave this page/);
});

test("an expired scoped transfer never completes and tells the learner how to resume", async t => {
  const view = fixture(t, call => allowAudio(call) ?? (call.body.action === "prepare" ? Response.json({ upload: audioRow, transfer: audioTransfer }) : undefined));
  transferFailure = new MockAudioTransferError("expired");
  await flush();
  await chooseAudio(view);
  assert.equal(transfers.length, 1);
  assert.equal(view.calls.filter(call => call.body.action === "complete").length, 0);
  assert.match(view.text(), /Upload authorization expired\. Choose the same file again to resume/);
});
