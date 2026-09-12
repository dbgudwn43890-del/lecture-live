import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { waitForConsentedInput, type LectureInput, type LectureInputSource } from "../lib/lecture-input.ts";
import type { ExternalPcmSource } from "../lib/external-pcm.ts";

type HookSlot = { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void };
let hooks: HookSlot[];
let cursor = 0;
let effects: Array<() => void>;
let rerender: () => void;
let acquire: (source: LectureInputSource) => Promise<LectureInput>;
type Capture = { state: "recording" | "stopping" | "inactive"; stop(): Promise<void>; push(bytes: number): void; stops: number };
let captures: Capture[];
mock.module("react", { namedExports: {
  useState(initial: unknown) {
    const index = cursor++;
    const slot = hooks[index] ??= { value: initial };
    return [slot.value, (value: unknown) => {
      slot.value = typeof value === "function" ? value(slot.value) : value;
      queueMicrotask(() => rerender());
    }];
  },
  useRef(initial: unknown) { const slot = hooks[cursor++] ??= { value: { current: initial } }; return slot.value; },
  useEffect(callback: () => void | (() => void), dependencies?: readonly unknown[]) {
    const slot = hooks[cursor++] ??= {};
    if (!slot.dependencies || !dependencies || dependencies.some((value, index) => !Object.is(value, slot.dependencies![index]))) {
      slot.dependencies = dependencies;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = callback() || undefined; });
    }
  },
} });
mock.module(pathToFileURL("app/lib/lecture-input.ts").href, { namedExports: {
  acquireLectureInput: (source: LectureInputSource) => acquire(source),
  waitForConsentedInput,
  LectureInputError: class extends Error { code: string; constructor(code: string) { super(code); this.code = code; } },
} });
mock.module(pathToFileURL("app/classroom/pcm-recorder.ts").href, { namedExports: {
  createPcmRecorder: async (_stream: MediaStream, onData: (data: ArrayBuffer) => void, onStop: () => Promise<void> | void) => {
    let stopped: Promise<void> | null = null;
    const capture: Capture = {
      state: "recording", stops: 0,
      push(bytes) { onData(new ArrayBuffer(bytes)); },
      stop() {
        if (stopped) return stopped;
        capture.stops++; capture.state = "stopping";
        // AudioWorklet.flush delivers asynchronously, after failed-start cleanup.
        stopped = Promise.resolve().then(async () => {
          onData(new ArrayBuffer(6_400));
          capture.state = "inactive";
          await onStop();
        });
        return stopped;
      },
    };
    captures.push(capture);
    onData(new ArrayBuffer(6_400));
    return capture;
  },
} });
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    try { return nextResolve(`${specifier}.ts`, context); } catch { throw error; }
  }
} });
const { useLectureRecorder } = await import("./use-lecture-recorder.ts");

const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function phoneSource(options: { started?: Promise<void>; stopFails?: boolean } = {}) {
  let live = true;
  let disposed = false;
  const events: string[] = [];
  const captures: Array<Capture & { ended(): void }> = [];
  const source: ExternalPcmSource = {
    async start(onData, onStop, onEnded) {
      events.push("start");
      let stopped: Promise<void> | null = null;
      const capture: Capture & { ended(): void } = {
        state: "recording", stops: 0,
        push(bytes) { onData(new ArrayBuffer(bytes)); },
        ended: onEnded,
        stop() {
          if (stopped) return stopped;
          capture.stops++; capture.state = "stopping";
          events.push("stop");
          stopped = Promise.resolve().then(async () => {
            onData(new ArrayBuffer(6_400));
            events.push("tail");
            capture.state = "inactive";
            if (options.stopFails) throw new Error("Phone acknowledgement lost");
            await onStop();
            events.push("drained");
          });
          return stopped;
        },
      };
      captures.push(capture);
      onData(new ArrayBuffer(6_400));
      await options.started;
      return capture;
    },
    isLive: () => live && !disposed,
    dispose() {
      if (disposed) return;
      disposed = true; events.push("dispose");
      for (const capture of captures) void capture.stop().catch(() => {});
    },
  };
  return { source, captures, events, get disposed() { return disposed; },
    disconnected() { live = false; captures.at(-1)?.ended(); },
    reconnect() { live = true; },
  };
}
function fixture(t: TestContext) {
  hooks = []; effects = []; captures = [];
  let mounted = true;
  let engine!: ReturnType<typeof useLectureRecorder>;
  const notices: string[] = [], errors: string[] = [];
  const inputs: LectureInput[] = [];
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const sockets: Socket[] = [];
  let tokenStatus = 200;
  let requestHandler: ((url: string, body: Record<string, unknown>) => Promise<Response> | undefined) | null = null;
  let sessionIndex = 0;
  const mirror = new Map<string, string>();
  const savedSessions: unknown[] = [];
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    sent: unknown[] = [];
    onopen: (() => void | Promise<void>) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    private closeListeners = new Set<() => void>();
    addEventListener(type: string, listener: () => void) { if (type === "close") this.closeListeners.add(listener); }
    removeEventListener(type: string, listener: () => void) { if (type === "close") this.closeListeners.delete(listener); }
    constructor() { sockets.push(this); }
    async open() { this.readyState = 1; await this.onopen?.(); }
    send(data: unknown) { this.sent.push(data); }
    close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => { this.onclose?.({ code: 1000 }); for (const listener of this.closeListeners) listener(); }); }
    disconnect() { this.readyState = 3; this.onclose?.({ code: 1006 }); for (const listener of this.closeListeners) listener(); }
  }
  const globalValues = {
    window: { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {}, removeEventListener() {}, localStorage: { get length() { return mirror.size; }, key(index: number) { return [...mirror.keys()][index] ?? null; }, getItem(key: string) { return mirror.get(key) ?? null; }, setItem(key: string, value: string) { mirror.set(key, value); }, removeItem(key: string) { mirror.delete(key); } } },
    document: { addEventListener() {}, removeEventListener() {}, documentElement: { style: { removeProperty() {} } } },
    navigator: {}, WebSocket: Socket,
    AudioContext: class { constructor() { throw new Error("No real audio in tests"); } },
    AudioWorkletNode: class {}, MediaStream: class {},
    fetch: async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push({ url, method: init.method ?? "GET", body });
      const custom = requestHandler?.(url, body);
      if (custom) return custom;
      if (url === "/api/deepgram-token") return tokenStatus === 200
        ? response({ accessToken: "mock-ticket", listenUrl: "wss://test.invalid", relay: true })
        : response({ error: "Speech recognition is temporarily unavailable." }, tokenStatus);
      if (body.action === "start") return response({ session: { id: `session-${++sessionIndex}`, title: "Test" } });
      if (init.method === "PATCH") return response({ saved: true, completed: body.action !== "save-final",
        acknowledgedSegmentIds: ((body.segments ?? []) as Array<{ id: string }>).map(segment => segment.id), session: { id: body.sessionId, status: "completed" } });
      return response({ recordedMs: 1_000 });
    },
  };
  const saved = Object.keys(globalValues).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globalValues)) Object.defineProperty(globalThis, key, { configurable: true, value });
  acquire = async source => {
    const track = { readyState: "live", enabled: true, onended: null, stop() { this.readyState = "ended"; } };
    const video = { readyState: "live", enabled: true, onended: null, stop() { this.readyState = "ended"; } };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track], getVideoTracks: () => [] } as unknown as MediaStream;
    const captureStream = source === "browser-tab"
      ? { getAudioTracks: () => [track], getTracks: () => [track, video], getVideoTracks: () => [video] } as unknown as MediaStream
      : stream;
    const input: LectureInput = { source, audioStream: stream, captureStream, disposed: false, dispose() {
      if (input.disposed) return;
      Object.assign(input, { disposed: true });
      captureStream.getTracks().forEach(track => track.stop());
    } };
    inputs.push(input);
    return input;
  };
  const options = {
    locale: "ko" as const, isEnglish: false, speechLanguage: "ko" as const,
    activeClassroomId: "classroom-1", activeSessionId: "", lectureTitle: "Test",
    setError: (value: string) => errors.push(value), setNotice: (value: string) => notices.push(value),
    clearMessages() {}, setActiveSessionId(value: string) { options.activeSessionId = value; queueMicrotask(() => rerender()); },
    setLectureTitle() {}, onCredits() {}, onSessionSaved(session: unknown) { savedSessions.push(session); }, async loadClassrooms() {}, async loadCredits() {},
  };
  rerender = () => {
    if (!mounted) return;
    cursor = 0; effects = [];
    engine = useLectureRecorder(options);
    for (const effect of effects) effect();
  };
  const unmount = () => { mounted = false; for (const slot of hooks) slot.cleanup?.(); };
  rerender();
  t.after(async () => {
    unmount(); await flush();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    get engine() { return engine; }, inputs, notices, errors, requests, sockets, mirror, savedSessions,
    tokenStatus(value: number) { tokenStatus = value; },
    handle(handler: typeof requestHandler) { requestHandler = handler; },
    async tick(milliseconds: number) { t.mock.timers.tick(milliseconds); await flush(); },
    unmount,
    async start() { const pending = engine.startLecture(); await flush(); return { pending }; },
  };
}

test("phone capture waits for consent and sends canonical PCM without requesting a desktop microphone", async t => {
  const f = fixture(t);
  const phone = phoneSource();
  const consent = deferred<void>();
  const pending = f.engine.startLecture("microphone", consent.promise, phone.source);
  await flush();
  assert.equal(f.inputs.length, 0);
  assert.equal(captures.length, 0, "the desktop must not construct a local PCM recorder");
  assert.equal(phone.captures.length, 0);
  assert.equal(f.requests.length, 0);
  consent.resolve(); await flush();
  assert.equal(phone.captures.length, 1);
  await f.sockets[0].open(); await pending; await flush();
  assert.equal(f.engine.phoneInput, true);
  assert.equal(f.engine.status, "recording");
  assert.equal(f.engine.inputSource, "microphone");
  assert.equal(f.engine.previewStream, null);
  assert.equal(f.requests.find(request => request.body.action === "start")?.body.inputSource, "microphone");
  assert.equal(f.sockets[0].sent.filter(frame => frame instanceof ArrayBuffer).reduce((total: number, frame) => total + (frame as ArrayBuffer).byteLength, 0), 6_400);
});

test("phone PCM queued across a relay reconnect uses the same capture and retains every frame", async t => {
  const f = fixture(t);
  const phone = phoneSource();
  const pending = f.engine.startLecture("microphone", undefined, phone.source); await flush();
  await f.sockets[0].open(); await pending; await flush();
  f.sockets[0].disconnect();
  phone.captures[0].push(32_000);
  await f.tick(1_000);
  assert.equal(f.sockets.length, 2);
  await f.sockets[1].open(); await flush();
  assert.equal(phone.captures.length, 1);
  assert.equal(f.inputs.length, 0);
  assert.equal(f.engine.status, "recording");
  assert.equal(f.sockets[1].sent.filter(frame => frame instanceof ArrayBuffer).reduce((total: number, frame) => total + (frame as ArrayBuffer).byteLength, 0), 32_000);
  assert.equal(phone.disposed, false);
});

test("phone pause keeps its pair, resume opens a fresh capture, and end flushes before revoking", async t => {
  const f = fixture(t);
  const phone = phoneSource();
  const pending = f.engine.startLecture("microphone", undefined, phone.source); await flush();
  await f.sockets[0].open(); await pending; await flush();
  const paused = f.engine.pauseLecture(); await flush();
  assert.equal(phone.events.at(-1), "drained");
  assert.equal(f.sockets[0].sent.at(-1), '{"type":"CloseStream"}');
  await f.tick(1_200); await paused;
  assert.equal(f.engine.status, "paused");
  assert.equal(f.engine.phoneInput, true);
  assert.equal(phone.disposed, false);
  const resumed = f.engine.resumeLecture(); await flush();
  assert.equal(phone.captures.length, 2);
  await f.sockets[1].open(); await resumed; await flush();
  assert.equal(f.engine.status, "recording");
  assert.equal(f.engine.streamOffsetMsRef.current, 1_000);
  const count = f.sockets[1].sent.length;
  phone.captures[0].push(20_000); phone.captures[0].ended(); await flush();
  assert.equal(f.sockets[1].sent.length, count, "old capture callbacks cannot affect the resumed stream");
  assert.equal(f.engine.status, "recording");
  assert.equal(f.inputs.length, 0);
  const ended = f.engine.finishLecture(); await flush();
  assert.equal(phone.disposed, false, "pair remains until the final PCM has drained");
  await f.tick(1_200); await ended; await flush();
  assert.equal(phone.disposed, true);
  assert.deepEqual(phone.events.slice(-2), ["drained", "dispose"]);
  assert.equal(f.engine.phoneInput, false);
  assert.equal(f.engine.status, "ended");
  assert.equal(f.requests.filter(request => request.body.action === "start").length, 1);
});

test("phone loss pauses with a phone-specific error and resume cannot fall back to the laptop", async t => {
  const f = fixture(t);
  const phone = phoneSource();
  const pending = f.engine.startLecture("microphone", undefined, phone.source); await flush();
  await f.sockets[0].open(); await pending; await flush();
  phone.disconnected(); await flush(); await f.tick(1_200);
  assert.equal(f.engine.status, "paused");
  assert.equal(f.engine.pauseReason, "capture-ended");
  assert.match(f.errors.at(-1) ?? "", /휴대폰/);
  assert.equal(phone.disposed, false);
  await f.engine.resumeLecture(); await flush();
  assert.equal(f.engine.status, "paused");
  assert.equal(f.inputs.length, 0);
  assert.equal(phone.captures.length, 1);
  assert.equal(f.requests.some(request => request.body.action === "resume"), false);
  phone.reconnect();
  const resumed = f.engine.resumeLecture(); await flush();
  await f.sockets[1].open(); await resumed; await flush();
  assert.equal(f.engine.status, "recording");
  assert.equal(phone.captures.length, 2);
});

test("a failed phone resume stops that capture but retains the pair for a deliberate retry", async t => {
  const f = fixture(t);
  const phone = phoneSource();
  const pending = f.engine.startLecture("microphone", undefined, phone.source); await flush();
  await f.sockets[0].open(); await pending; await flush();
  const paused = f.engine.pauseLecture(); await flush(); await f.tick(1_200); await paused;
  f.tokenStatus(503);
  await f.engine.resumeLecture(); await flush();
  assert.equal(f.engine.status, "paused");
  assert.equal(phone.disposed, false);
  assert.equal(phone.captures[1].state, "inactive");
  assert.equal(f.inputs.length, 0);
  f.tokenStatus(200);
  const resumed = f.engine.resumeLecture(); await flush();
  await f.sockets[1].open(); await resumed; await flush();
  assert.equal(f.engine.status, "recording");
  assert.equal(phone.captures.length, 3);
});

test("a lost phone stop acknowledgement still pauses or ends the server session", async t => {
  const f = fixture(t);
  const phone = phoneSource({ stopFails: true });
  const pending = f.engine.startLecture("microphone", undefined, phone.source); await flush();
  await f.sockets[0].open(); await pending; await flush();
  const paused = f.engine.pauseLecture(); await flush(); await f.tick(1_200); await paused;
  assert.equal(f.engine.status, "paused");
  assert.ok(f.requests.some(request => request.body.action === "pause"));
  assert.match(f.errors.at(-1) ?? "", /휴대폰/);
  const ended = f.engine.finishLecture(); await flush(); await f.tick(1_200); await ended;
  assert.equal(f.engine.status, "ended");
  assert.equal(phone.disposed, true);
  assert.ok(f.requests.some(request => request.method === "PATCH"));
});

test("failed phone startup revokes the pair and cannot contaminate the next local microphone", async t => {
  const f = fixture(t);
  const phone = phoneSource();
  f.tokenStatus(503);
  await f.engine.startLecture("microphone", undefined, phone.source); await flush();
  assert.equal(phone.disposed, true);
  assert.equal(f.engine.phoneInput, false);
  assert.equal(f.engine.status, "error");
  assert.equal(f.notices.some(text => text.includes("보내지 못")), false);
  f.tokenStatus(200);
  const { pending } = await f.start();
  await f.sockets[0].open(); await pending; await flush();
  const count = f.sockets[0].sent.length;
  phone.captures[0].push(32_000); phone.captures[0].ended(); await flush();
  assert.equal(f.sockets[0].sent.length, count);
  assert.equal(f.engine.status, "recording");
  assert.equal(f.inputs.length, 1);
  assert.equal(f.engine.phoneInput, false);
});

test("a late phone start acknowledgement after finish cannot affect a newer local capture", async t => {
  const f = fixture(t);
  const started = deferred<void>();
  const phone = phoneSource({ started: started.promise });
  const old = f.engine.startLecture("microphone", undefined, phone.source); await flush();
  assert.equal(phone.captures.length, 1);
  await f.engine.finishLecture(); await flush();
  assert.equal(phone.disposed, true);
  const { pending } = await f.start();
  await f.sockets[0].open(); await pending; await flush();
  started.resolve(); await old; await flush();
  const count = f.sockets[0].sent.length;
  phone.captures[0].push(32_000); phone.captures[0].ended(); await flush();
  assert.equal(f.sockets[0].sent.length, count);
  assert.equal(f.engine.status, "recording");
  assert.equal(captures[0].state, "recording");
  assert.equal(f.requests.filter(request => request.body.action === "start").length, 1);
});

test("unmount while phone consent is pending revokes it without starting capture or the server", async t => {
  const f = fixture(t);
  const consent = deferred<void>();
  const phone = phoneSource();
  const pending = f.engine.startLecture("microphone", consent.promise, phone.source); await flush();
  f.unmount(); await pending; await flush();
  assert.equal(phone.disposed, true);
  assert.equal(phone.captures.length, 0);
  assert.equal(f.requests.length, 0);
  consent.resolve(); await flush();
  assert.equal(phone.captures.length, 0);
});

test("phone loss before the first relay open cannot become a phantom recording", async t => {
  const f = fixture(t);
  const phone = phoneSource();
  const pending = f.engine.startLecture("microphone", undefined, phone.source); await flush();
  phone.disconnected(); await pending; await flush();
  assert.equal(f.engine.status, "error");
  assert.equal(phone.disposed, true);
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal(f.inputs.length, 0);
  assert.match(f.errors.at(-1) ?? "", /휴대폰/);
});

test("a restored paused session attaches a fresh phone pair and resumes the same lecture", async t => {
  const f = fixture(t);
  f.engine.activeSessionIdRef.current = "restored-phone-session";
  f.engine.restoreInputSource("microphone");
  f.engine.setStatus("paused"); await flush();
  const phone = phoneSource();
  const resumed = f.engine.resumeLecture(phone.source); await flush();
  await f.sockets[0].open(); await resumed; await flush();
  assert.equal(f.engine.status, "recording");
  assert.equal(f.engine.phoneInput, true);
  assert.equal(f.inputs.length, 0);
  assert.equal(f.requests.filter(request => request.body.action === "start").length, 0);
  assert.equal(f.requests.find(request => request.body.action === "resume")?.body.sessionId, "restored-phone-session");
  assert.equal(f.requests.find(request => request.url === "/api/deepgram-token")?.body.sessionId, "restored-phone-session");
});

test("re-pairing a paused phone releases the old pair and ignores its late frames", async t => {
  const f = fixture(t), oldPhone = phoneSource();
  const pending = f.engine.startLecture("microphone", undefined, oldPhone.source); await flush();
  await f.sockets[0].open(); await pending; await flush();
  const paused = f.engine.pauseLecture(); await flush(); await f.tick(1_200); await paused;
  const phone = phoneSource();
  const resumed = f.engine.resumeLecture(phone.source); await flush();
  assert.equal(oldPhone.disposed, true);
  await f.sockets[1].open(); await resumed; await flush();
  const sent = f.sockets[1].sent.length;
  oldPhone.captures[0].push(32_000); oldPhone.captures[0].ended(); await flush();
  assert.equal(f.sockets[1].sent.length, sent);
  assert.equal(f.engine.status, "recording");
  assert.equal(f.inputs.length, 0);
});

test("computer → phone → computer keeps the same lecture, transcript and clock offset", async t => {
  const f = fixture(t);
  const { pending } = await f.start();
  await f.sockets[0].open(); await pending; await flush();
  const previous = { id: "earlier", startMs: 0, endMs: 900, text: "앞에서 정리한 내용" };
  f.engine.setSegments([previous]); await flush();
  const phone = phoneSource();
  const switched = f.engine.switchMicrophone("phone", phone.source); await flush();
  assert.equal(f.engine.isSwitchingMicrophone, true);
  assert.equal(f.engine.status, "paused");
  assert.equal(phone.captures.length, 0, "replacement waits for old PCM and server pause");
  await f.tick(1_200);
  assert.equal(f.inputs[0].disposed, true);
  assert.equal(captures[0].state, "inactive");
  assert.equal(phone.captures.length, 1);
  await f.sockets[1].open();
  assert.equal(await switched, true); await flush();
  assert.equal(f.engine.isSwitchingMicrophone, false);
  assert.equal(f.engine.phoneInput, true);
  assert.deepEqual(f.engine.segments, [previous]);
  assert.equal(f.engine.streamOffsetMsRef.current, 1_000);
  const returned = f.engine.switchMicrophone("computer"); await flush();
  assert.equal(phone.disposed, false, "pair survives until the phone's final PCM is drained");
  await f.tick(1_200);
  assert.equal(phone.disposed, true);
  assert.equal(f.inputs.length, 2);
  await f.sockets[2].open();
  assert.equal(await returned, true); await flush();
  assert.equal(f.engine.phoneInput, false);
  assert.equal(f.engine.status, "recording");
  assert.deepEqual(f.engine.segments, [previous]);
  assert.equal(f.engine.streamOffsetMsRef.current, 1_000);
  assert.equal(f.requests.filter(request => request.body.action === "start").length, 1);
  assert.equal(f.requests.filter(request => request.body.action === "resume").length, 2);
  assert.ok(f.requests.filter(request => request.body.action === "pause" || request.body.action === "resume")
    .every(request => request.body.sessionId === "session-1"));
  const sent = f.sockets[2].sent.length;
  phone.captures[0].push(32_000); phone.captures[0].ended(); await flush();
  assert.equal(f.sockets[2].sent.length, sent, "retired phone cannot send or pause the computer");
  assert.equal(f.engine.status, "recording");
});

test("a paused phone can explicitly switch to computer without a second pause", async t => {
  const f = fixture(t), phone = phoneSource();
  const pending = f.engine.startLecture("microphone", undefined, phone.source); await flush();
  await f.sockets[0].open(); await pending; await flush();
  const paused = f.engine.pauseLecture(); await flush(); await f.tick(1_200); await paused;
  const switched = f.engine.switchMicrophone("computer"); await flush();
  await f.sockets[1].open();
  assert.equal(await switched, true); await flush();
  assert.equal(f.engine.phoneInput, false);
  assert.equal(f.engine.isCurrentPhoneSource(phone.source), false);
  assert.equal(phone.disposed, true);
  assert.equal(f.requests.filter(request => request.body.action === "pause").length, 1);
  assert.equal(f.requests.filter(request => request.body.action === "resume").length, 1);
});

test("a missing or disconnected replacement phone never stops the current computer microphone", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  const phone = phoneSource(); phone.disconnected();
  assert.equal(await f.engine.switchMicrophone("phone"), false);
  assert.equal(await f.engine.switchMicrophone("phone", phone.source), false);
  assert.equal(await f.engine.switchMicrophone("computer"), true, "current device is an idempotent no-op");
  assert.equal(f.engine.status, "recording");
  assert.equal(captures[0].stops, 0);
  assert.equal(f.requests.some(request => request.body.action === "pause"), false);
  assert.match(f.errors.at(-1) ?? "", /휴대폰/);
});

test("computer permission cancellation during a phone switch leaves the lecture paused and retryable", async t => {
  const f = fixture(t), phone = phoneSource();
  const pending = f.engine.startLecture("microphone", undefined, phone.source); await flush();
  await f.sockets[0].open(); await pending; await flush();
  const originalAcquire = acquire;
  acquire = async () => { throw new DOMException("Permission denied", "NotAllowedError"); };
  const switched = f.engine.switchMicrophone("computer"); await flush(); await f.tick(1_200);
  assert.equal(await switched, false); await flush();
  assert.equal(f.engine.status, "paused");
  assert.equal(f.engine.isSwitchingMicrophone, false);
  assert.equal(f.engine.phoneInput, false);
  assert.equal(phone.disposed, true);
  assert.equal(f.inputs.length, 0);
  assert.equal(f.requests.some(request => request.body.action === "resume"), false);
  acquire = originalAcquire;
  const retry = f.engine.resumeLecture(); await flush(); await f.sockets[1].open();
  assert.equal(await retry, true); await flush();
  assert.equal(f.engine.status, "recording");
  assert.equal(f.requests.filter(request => request.body.action === "start").length, 1);
});

test("replacement ticket failure restores paused state and preserves the adopted phone for retry", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  const phone = phoneSource();
  f.tokenStatus(503);
  const switched = f.engine.switchMicrophone("phone", phone.source); await flush(); await f.tick(1_200);
  assert.equal(await switched, false); await flush();
  assert.equal(f.engine.status, "paused");
  assert.equal(f.engine.phoneInput, true);
  assert.equal(f.engine.isCurrentPhoneSource(phone.source), true);
  assert.equal(phone.disposed, false);
  assert.equal(phone.captures[0].state, "inactive");
  assert.equal(f.requests.filter(request => request.body.action === "pause").length, 2);
  f.tokenStatus(200);
  const retry = f.engine.resumeLecture(); await flush(); await f.sockets[1].open();
  assert.equal(await retry, true); await flush();
  assert.equal(f.engine.status, "recording");
  assert.equal(f.inputs.length, 1);
  assert.equal(f.requests.filter(request => request.body.action === "start").length, 1);
});

test("a failed pause save prevents the replacement from capturing or resuming", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  const phone = phoneSource();
  f.handle((_url, body) => body.action === "pause" ? Promise.resolve(response({}, 503)) : undefined);
  const switched = f.engine.switchMicrophone("phone", phone.source); await flush(); await f.tick(1_200);
  assert.equal(await switched, false); await flush();
  assert.equal(f.engine.status, "paused");
  assert.equal(f.engine.isSwitchingMicrophone, false);
  assert.equal(phone.captures.length, 0);
  assert.equal(f.engine.phoneInput, false);
  assert.equal(f.engine.isCurrentPhoneSource(phone.source), false);
  assert.equal(f.requests.some(request => request.body.action === "resume"), false);
  assert.match(f.notices.at(-1) ?? "", /일시정지/);
});

test("overlapping switches and ordinary resume cannot race a pending device handoff", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  const phone = phoneSource();
  const first = f.engine.switchMicrophone("phone", phone.source);
  assert.equal(await f.engine.switchMicrophone("computer"), false);
  assert.equal(await f.engine.switchMicrophone("phone", phone.source), false);
  await flush();
  assert.equal(await f.engine.resumeLecture(), false);
  await f.tick(1_200);
  await f.sockets[1].open();
  assert.equal(await first, true); await flush();
  assert.equal(phone.captures.length, 1);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.requests.filter(request => request.body.action === "resume").length, 1);
});

test("unmount during old capture drain cancels a device switch before replacement capture", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  const phone = phoneSource();
  const switched = f.engine.switchMicrophone("phone", phone.source); await flush();
  f.unmount(); await f.tick(1_200);
  assert.equal(await switched, false);
  assert.equal(phone.captures.length, 0);
  assert.equal(f.requests.some(request => request.body.action === "resume"), false);
});

test("late computer permission after leaving a phone switch is released without resuming", async t => {
  const f = fixture(t), phone = phoneSource();
  const pending = f.engine.startLecture("microphone", undefined, phone.source); await flush();
  await f.sockets[0].open(); await pending; await flush();
  const acquiring = deferred<LectureInput>();
  const originalAcquire = acquire;
  acquire = source => { void originalAcquire(source); return acquiring.promise; };
  const switched = f.engine.switchMicrophone("computer"); await flush(); await f.tick(1_200);
  assert.equal(f.inputs.length, 1);
  f.unmount(); acquiring.resolve(f.inputs[0]);
  assert.equal(await switched, false); await flush();
  assert.equal(f.inputs[0].disposed, true);
  assert.equal(f.requests.some(request => request.body.action === "resume"), false);
  assert.equal(captures.length, 0);
});

test("a local stop failure during switching closes capture and pauses server before retry", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  const phone = phoneSource();
  captures[0].stop = async () => { throw new Error("Audio worklet flush failed"); };
  assert.equal(await f.engine.switchMicrophone("phone", phone.source), false); await flush();
  assert.equal(f.engine.status, "paused");
  assert.equal(f.engine.isSwitchingMicrophone, false);
  assert.equal(f.inputs[0].disposed, true);
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal(phone.captures.length, 0);
  assert.ok(f.requests.some(request => request.body.action === "pause"));
  assert.match(f.errors.at(-1) ?? "", /마이크 전환/);
});

test("device switching cannot turn a browser-tab session into a microphone session", async t => {
  const f = fixture(t);
  const pending = f.engine.startLecture("browser-tab"); await flush();
  await f.sockets[0].open(); await pending; await flush();
  const phone = phoneSource();
  assert.equal(await f.engine.switchMicrophone("computer"), false);
  assert.equal(await f.engine.switchMicrophone("phone", phone.source), false);
  assert.equal(f.engine.inputSource, "browser-tab");
  assert.equal(f.engine.status, "recording");
  assert.equal(f.inputs[0].disposed, false);
  assert.equal(f.requests.some(request => request.body.action === "pause"), false);
});

test("initial ticket 503 discards late PCM flush without claiming recorded audio was lost; retry works", async t => {
  const f = fixture(t);
  f.tokenStatus(503);
  await f.engine.startLecture(); await flush();
  assert.equal(f.engine.status, "error");
  assert.equal(f.engine.connectingPhase, null);
  assert.equal(f.engine.startedAtRef.current, 0);
  assert.equal(captures[0].state, "inactive");
  assert.equal(f.inputs[0].disposed, true);
  assert.equal(f.notices.some(text => text.includes("보내지 못")), false);
  assert.equal(f.sockets.length, 0);
  assert.ok(f.requests.some(request => request.method === "PATCH" && request.body.sessionId === "session-1"));
  f.tokenStatus(200);
  const { pending } = await f.start();
  assert.equal(f.engine.status, "connecting");
  await f.sockets[0].open(); await pending; await flush();
  assert.equal(f.engine.status, "recording");
  assert.equal(captures[1].state, "recording");
});

test("an active-recording conflict preserves the server's explanation, releases this attempt, and permits retry", async t => {
  const f = fixture(t);
  const message = "다른 탭이나 기기에서 녹음 중입니다. 해당 녹음을 일시정지하거나 종료한 뒤 다시 시작해 주세요.";
  f.handle(url => url === "/api/deepgram-token"
    ? Promise.resolve(response({ code: "RECORDING_ALREADY_ACTIVE", retryable: false, error: message }, 409))
    : undefined);
  await f.engine.startLecture(); await flush();
  assert.equal(f.errors.at(-1), message);
  assert.equal(f.engine.status, "error");
  assert.equal(f.inputs[0].disposed, true);
  assert.equal(captures[0].state, "inactive");
  assert.equal(f.sockets.length, 0, "a rejected ticket must never open a speech connection");
  assert.equal(f.notices.some(text => text.includes("보내지 못")), false);
  assert.ok(f.requests.filter(request => request.method === "PATCH")
    .every(request => request.body.sessionId === "session-1"), "only this failed attempt may be cleaned up");
  const requests = f.requests.length;
  await f.tick(60_000);
  assert.equal(f.requests.length, requests, "the initial conflict must not cause a reconnect loop");
  f.handle(null); // The other recording has ended; a deliberate retry can proceed.
  const { pending } = await f.start();
  await f.sockets[0].open(); await pending; await flush();
  assert.equal(f.engine.status, "recording");
  assert.equal(f.errors.at(-1), "");
});

test("a socket closing before open without an error exits connecting and cleans capture", async t => {
  const f = fixture(t);
  const { pending } = await f.start();
  f.sockets[0].disconnect(); await pending; await flush();
  assert.equal(f.engine.status, "error");
  assert.equal(f.engine.connectingPhase, null);
  assert.equal(captures[0].state, "inactive");
  assert.equal(f.notices.some(text => text.includes("보내지 못")), false);
  await f.tick(60_000);
  assert.equal(f.sockets.length, 1, "failed first connection must not leave a reconnect loop");
});

test("a stalled first socket has a bounded deadline and no spurious lost-audio notice", async t => {
  const f = fixture(t);
  const { pending } = await f.start();
  await f.tick(15_000); await pending;
  assert.equal(f.engine.status, "error");
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal(f.inputs[0].disposed, true);
  assert.equal(f.notices.some(text => text.includes("보내지 못")), false);
});

test("microphone ending during connection setup cannot become a phantom recording", async t => {
  const f = fixture(t);
  const { pending } = await f.start();
  f.inputs[0].audioStream.getAudioTracks()[0].stop();
  await f.sockets[0].open(); await pending; await flush();
  assert.equal(f.engine.status, "error");
  assert.equal(captures[0].state, "inactive");
  assert.equal(f.inputs[0].disposed, true);
});

test("actual audio left unsent after a recording disconnect still reports a gap on pause", async t => {
  const f = fixture(t);
  const { pending } = await f.start();
  await f.sockets[0].open(); await pending; await flush();
  f.sockets[0].disconnect(); captures[0].push(32_000);
  const paused = f.engine.pauseLecture(); await flush();
  await f.tick(1_200); await paused;
  assert.equal(f.engine.status, "paused");
  assert.ok(f.notices.some(text => text.includes("보내지 못했어요")));
});

test("failed resume restores paused state and disables a retained shared track; next resume opens", async t => {
  const f = fixture(t);
  const pending = f.engine.startLecture("browser-tab"); await flush();
  await f.sockets[0].open(); await pending; await flush();
  const pause = f.engine.pauseLecture(); await flush();
  await f.tick(1_200); await pause; await flush();
  f.tokenStatus(503);
  await f.engine.resumeLecture(); await flush();
  assert.equal(f.engine.status, "paused");
  assert.equal(f.inputs[0].disposed, false);
  assert.equal(f.inputs[0].audioStream.getAudioTracks()[0].enabled, false);
  assert.equal(f.engine.finishingRef.current, false);
  f.tokenStatus(200);
  const resumed = f.engine.resumeLecture(); await flush();
  await f.sockets.at(-1)!.open(); await resumed; await flush();
  assert.equal(f.engine.status, "recording");
  assert.equal(f.inputs.length, 1);
});

test("a late start response after finish cannot stop the newer recording", async t => {
  const f = fixture(t);
  let resolveStart!: (value: Response) => void;
  let first = true;
  f.handle((_url, body) => {
    if (body.action === "start" && first) { first = false; return new Promise(resolve => { resolveStart = resolve; }); }
  });
  const oldStart = f.engine.startLecture(); await flush();
  const finish = f.engine.finishLecture(); await flush();
  await f.tick(1_200); await finish; await flush();
  const { pending } = await f.start();
  await f.sockets[0].open(); await pending; await flush();
  resolveStart(response({ session: { id: "old-session", title: "Old" } }));
  await oldStart; await flush();
  assert.equal(f.engine.status, "recording");
  assert.equal(captures[1].state, "recording");
  assert.notEqual(f.engine.startedAtRef.current, 0);
  assert.ok(f.requests.some(request => request.method === "PATCH" && request.body.sessionId === "old-session"));
});

test("unmount during resume pauses the captured session even when its token arrives late", async t => {
  const f = fixture(t);
  f.engine.setStatus("paused");
  f.engine.activeSessionIdRef.current = "paused-session";
  await flush();
  let resolveToken!: (value: Response) => void;
  f.handle(url => url === "/api/deepgram-token" ? new Promise(resolve => { resolveToken = resolve; }) : undefined);
  const resume = f.engine.resumeLecture(); await flush();
  f.unmount();
  f.engine.activeSessionIdRef.current = "other-session";
  resolveToken(response({ accessToken: "mock-ticket", listenUrl: "wss://test.invalid", relay: true }));
  await resume; await flush();
  assert.equal(f.sockets.length, 0);
  assert.ok(f.requests.some(request => request.body.action === "pause" && request.body.sessionId === "paused-session"));
  assert.equal(f.requests.some(request => request.body.action === "pause" && request.body.sessionId === "other-session"), false);
});

test("a stale reconnect fetch rejection cannot start a reconnect for the next lecture", async t => {
  const f = fixture(t);
  const { pending } = await f.start();
  await f.sockets[0].open(); await pending; await flush();
  let rejectToken!: (error: Error) => void;
  f.handle(url => url === "/api/deepgram-token" ? new Promise((_resolve, reject) => { rejectToken = reject; }) : undefined);
  f.sockets[0].disconnect();
  await f.tick(1_000);
  const finish = f.engine.finishLecture(); await flush();
  await f.tick(1_200); await finish; await flush();
  f.handle(null);
  const next = await f.start();
  await f.sockets.at(-1)!.open(); await next.pending; await flush();
  const tokenRequests = f.requests.filter(request => request.url === "/api/deepgram-token").length;
  rejectToken(new TypeError("old connection failed")); await flush();
  await f.tick(60_000);
  assert.equal(f.requests.filter(request => request.url === "/api/deepgram-token").length, tokenRequests);
  assert.equal(f.engine.status, "recording");
});

for (const source of ["microphone", "browser-tab"] as const) {
  test(`${source} opens capture synchronously but starts PCM and the session only after consent`, async t => {
    const f = fixture(t);
    const consent = deferred<void>();
    const pending = f.engine.startLecture(source, consent.promise);
    assert.equal(f.inputs.length, 1, "the browser picker is invoked in the caller's click");
    assert.equal(f.inputs[0].source, source);
    await flush();
    assert.equal(captures.length, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.sockets.length, 0);
    assert.equal(f.engine.startedAtRef.current, 0);
    assert.equal(f.engine.previewStream, null);
    consent.resolve();
    await flush();
    assert.equal(captures.length, 1);
    assert.equal(f.requests.filter(request => request.body.action === "start").length, 1);
    assert.equal(f.requests.filter(request => request.url === "/api/deepgram-token").length, 1);
    assert.equal(f.sockets.length, 1);
    await f.sockets[0].open();
    await pending; await flush();
    assert.equal(f.engine.status, "recording");
    assert.equal(f.inputs[0].disposed, false);
  });
}

test("consent rejection disposes capture without PCM, a session, or a provider request", async t => {
  const f = fixture(t);
  const consent = deferred<void>();
  const pending = f.engine.startLecture("browser-tab", consent.promise);
  await flush();
  consent.reject(new Error("동의 기록을 저장하지 못했습니다."));
  await pending; await flush();
  assert.equal(f.inputs[0].disposed, true);
  assert.ok(f.inputs[0].captureStream.getTracks().every(track => track.readyState === "ended"));
  assert.equal(captures.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.sockets.length, 0);
  assert.equal(f.engine.status, "error");
  assert.equal(f.engine.startedAtRef.current, 0);
  assert.equal(f.engine.connectingPhase, null);
});

for (const action of ["unmount", "finish"] as const) {
  for (const inputLate of [false, true]) {
    test(`${action} aborts consent waiting and releases ${inputLate ? "late" : "already acquired"} input`, async t => {
      const f = fixture(t);
      const consent = deferred<void>();
      const acquiring = deferred<LectureInput>();
      if (inputLate) {
        const originalAcquire = acquire;
        acquire = source => { void originalAcquire(source); return acquiring.promise; };
      }
      const pending = f.engine.startLecture("browser-tab", consent.promise);
      await flush();
      if (action === "unmount") f.unmount();
      else await f.engine.finishLecture();
      await pending; await flush();
      if (inputLate) acquiring.resolve(f.inputs[0]);
      consent.resolve();
      await flush();
      assert.equal(f.inputs[0].disposed, true);
      assert.ok(f.inputs[0].captureStream.getTracks().every(track => track.readyState === "ended"));
      assert.equal(captures.length, 0);
      assert.equal(f.requests.length, 0);
      assert.equal(f.sockets.length, 0);
      assert.equal(f.engine.startedAtRef.current, 0);
    });
  }
}

test("double start with the same pending consent opens one picker and one recording", async t => {
  const f = fixture(t);
  const consent = deferred<void>();
  const first = f.engine.startLecture("browser-tab", consent.promise);
  const second = f.engine.startLecture("browser-tab", consent.promise);
  assert.equal(f.inputs.length, 1, "the ref guard applies before a rerender");
  await flush();
  assert.equal(captures.length, 0);
  assert.equal(f.requests.length, 0);
  consent.resolve();
  await flush();
  await f.sockets[0].open();
  await Promise.all([first, second]); await flush();
  assert.equal(f.inputs.length, 1);
  assert.equal(captures.length, 1);
  assert.equal(f.requests.filter(request => request.body.action === "start").length, 1);
  assert.equal(f.requests.filter(request => request.url === "/api/deepgram-token").length, 1);
  assert.equal(f.engine.status, "recording");
});


test("finish sends 5,001 unconfirmed segments in bounded batches and removes the mirror only after completion ACK", async t => {
  const f = fixture(t);
  const segments = Array.from({ length: 5001 }, (_, index) => ({ id: String(index), startMs: index, endMs: index + 1, text: "Saved sentence" }));
  f.engine.setSegments(segments); await flush();
  f.engine.activeSessionIdRef.current = "long-session";
  const confirmation = deferred<Response>();
  f.handle((_url, body) => body.sessionId === "long-session" && !body.action ? confirmation.promise : undefined);
  const ending = f.engine.finishLecture();
  for (let index = 0; index < 30; index++) await flush();
  const batches = f.requests.filter(request => request.body.action === "save-final");
  assert.equal(batches.length, 21);
  assert.ok(batches.every(request => (request.body.segments as unknown[]).length <= 250));
  assert.deepEqual(batches.flatMap(request => request.body.segments), segments);
  assert.deepEqual(JSON.parse(f.mirror.get("lecue-unsaved-finish-long-session")!).segments, []);
  assert.equal(f.savedSessions.length, 0);
  confirmation.resolve(response({ saved: true, completed: true, session: { id: "long-session", status: "completed" } }));
  await ending; await flush();
  assert.equal(f.mirror.has("lecue-unsaved-finish-long-session"), false);
  assert.equal(f.savedSessions.length, 1);
});

test("finish resends only the unsaved tail after 5,000 confirmed live segments", async t => {
  const f = fixture(t);
  const segments = Array.from({ length: 5001 }, (_, index) => ({ id: String(index), startMs: index, endMs: index + 1, text: "Sentence" }));
  f.engine.setSegments(segments); await flush();
  f.engine.activeSessionIdRef.current = "confirmed-session";
  for (const segment of segments.slice(0, 5000)) f.engine.confirmedSegmentIdsRef.current.add(segment.id);
  await f.engine.finishLecture(); await flush();
  assert.deepEqual(f.requests.filter(request => request.body.action === "save-final").flatMap(request => request.body.segments), [segments[5000]]);
  assert.equal(f.mirror.size, 0);
});

for (const failure of ["missing-ack", "database", "false-completion"] as const) {
  test(`finish retains the recovery mirror after ${failure} and retries without losing the tail`, async t => {
    const f = fixture(t);
    const segments = [{ id: "last", startMs: 0, endMs: 1000, text: "Keep this sentence" }];
    f.engine.setSegments(segments); await flush();
    f.engine.activeSessionIdRef.current = "retry-session";
    f.handle((_url, body) => {
      if (body.action === "save-final" && failure === "missing-ack") return Promise.resolve(response({ saved: true, acknowledgedSegmentIds: [] }));
      if (body.action === "save-final" && failure === "database") return Promise.resolve(response({ error: "Database temporarily unavailable" }, 503));
      if (!body.action && failure === "false-completion") return Promise.resolve(response({ saved: true, completed: false }));
    });
    await f.engine.finishLecture(); await flush();
    assert.ok(f.mirror.has("lecue-unsaved-finish-retry-session"));
    assert.equal(f.savedSessions.length, 0);
    if (failure !== "false-completion") assert.deepEqual(JSON.parse(f.mirror.get("lecue-unsaved-finish-retry-session")!).segments, segments);
    const batchesBeforeRetry = f.requests.filter(request => request.body.action === "save-final").length;
    f.handle(null);
    await f.tick(30_000); await flush();
    assert.equal(f.mirror.has("lecue-unsaved-finish-retry-session"), false);
    assert.equal(f.savedSessions.length, 1);
    if (failure === "false-completion") assert.equal(f.requests.filter(request => request.body.action === "save-final").length, batchesBeforeRetry, "an acknowledged batch is not sent again");
  });
}


test("normal relay-close overlap retries briefly without clearing the lease or showing a premature save error", async t => {
  const f = fixture(t);
  f.engine.activeSessionIdRef.current = "closing-session";
  let attempts = 0;
  f.handle((_url, body) => {
    if (body.sessionId === "closing-session" && attempts++ < 3) return Promise.resolve(response({ code: "RECORDING_ALREADY_ACTIVE", error: "The recording connection is still active." }, 409));
  });
  const ending = f.engine.finishLecture(); await flush();
  for (const delay of [400, 800, 1600]) {
    assert.ok(f.mirror.has("lecue-unsaved-finish-closing-session"));
    assert.equal(f.savedSessions.length, 0);
    await f.tick(delay);
  }
  await ending; await flush();
  assert.equal(attempts, 4);
  assert.equal(f.mirror.size, 0);
  assert.equal(f.savedSessions.length, 1);
  assert.equal(f.errors.some(error => error.includes("active")), false);
  assert.equal(f.requests.some(request => request.body.action === "pause"), false);
});

test("a still-active recording keeps its mirror after the bounded close grace period", async t => {
  const f = fixture(t);
  f.engine.activeSessionIdRef.current = "other-recording";
  f.handle(() => Promise.resolve(response({ code: "RECORDING_ALREADY_ACTIVE", error: "The recording connection is still active." }, 409)));
  const ending = f.engine.finishLecture(); await flush();
  for (const delay of [400, 800, 1600]) await f.tick(delay);
  await ending; await flush();
  assert.ok(f.mirror.has("lecue-unsaved-finish-other-recording"));
  assert.equal(f.savedSessions.length, 0);
  assert.equal(f.errors.at(-1), "The recording connection is still active.");
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests.some(request => request.body.action === "pause"), false);
});


for (const status of [200, 409]) {
  test(`a late segment response (${status}) cannot confirm or finish a newer lecture`, async t => {
    const f = fixture(t);
    const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
    const segmentResponse = deferred<Response>();
    f.handle((_url, body) => body.action === "segment" ? segmentResponse.promise : undefined);
    f.sockets[0].onmessage?.({ data: JSON.stringify({ type: "Results", is_final: true, speech_final: true, start: 0, duration: 1,
      channel: { alternatives: [{ transcript: "Same opening sentence" }] } }) });
    await flush();
    const segmentRequest = f.requests.find(request => request.body.action === "segment");
    assert.ok(segmentRequest);
    const segment = segmentRequest.body.segment as { id: string };
    f.engine.activeSessionIdRef.current = "newer-session";
    f.engine.confirmedSegmentIdsRef.current.clear();
    segmentResponse.resolve(response(status === 200 ? { saved: true } : { error: "Old lecture ended" }, status));
    await flush();
    assert.equal(f.engine.confirmedSegmentIdsRef.current.has(segment.id), false);
    assert.equal(f.engine.status, "recording");
    assert.equal(f.requests.some(request => request.method === "PATCH" && request.body.sessionId === "newer-session"), false);
  });
}


for (const source of ["microphone", "browser-tab"] as const) {
  test(`${source} capture pauses immediately while server acknowledgement is pending`, async t => {
    const f = fixture(t);
    const started = f.engine.startLecture(source); await flush(); await f.sockets[0].open(); await started; await flush();
    const serverPause = deferred<Response>();
    f.handle((_url, body) => body.action === "pause" ? serverPause.promise : undefined);
    const paused = f.engine.pauseLecture();
    const track = f.inputs[0].audioStream.getAudioTracks()[0];
    assert.ok(track.readyState === "ended" || !track.enabled, "capture stops before any asynchronous work");
    assert.equal(captures[0].state, "stopping");
    await flush();
    assert.equal(f.engine.status, "paused");
    assert.equal(f.engine.isPausing, true);
    assert.equal(f.engine.isFinalizing, true, "global finalization guards remain engaged");
    await f.sockets[0].close(); await flush();
    assert.ok(f.requests.some(request => request.body.action === "pause"), "a closed stream starts server saving within the existing close grace");
    assert.equal(await f.engine.resumeLecture(), false);
    assert.equal(f.requests.some(request => request.body.action === "resume"), false);
    serverPause.resolve(response({ status: "paused", recordedMs: 1000 }));
    await flush();
    assert.equal(f.engine.isPausing, true, "server acknowledgement does not bypass the relay close grace");
    await f.tick(1200); await paused; await flush();
    assert.equal(f.engine.isPausing, false);
    assert.equal(f.engine.isFinalizing, false);
    assert.equal(f.engine.status, "paused");
  });
}

test("pause retains final speech and overlaps server save with the relay close grace", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  const paused = f.engine.pauseLecture(); await flush();
  assert.equal(f.requests.some(request => request.body.action === "pause"), false);
  f.sockets[0].onmessage?.({ data: JSON.stringify({ type: "Results", is_final: true, speech_final: false, start: 0, duration: 1,
    channel: { alternatives: [{ transcript: "Preserve the final paused sentence" }] } }) });
  f.sockets[0].close(); await flush();
  assert.ok(f.requests.some(request => request.body.action === "pause"));
  assert.equal(f.engine.isPausing, true);
  await f.tick(1200); await paused; await flush();
  assert.equal(f.engine.segments.at(-1)?.text, "Preserve the final paused sentence");
  assert.ok(f.requests.some(request => request.body.action === "segment"));
  assert.ok(f.requests.some(request => request.body.action === "pause"));
  assert.equal(f.engine.isPausing, false);
});

test("pause keeps the full fallback window when the provider has not closed", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  const paused = f.engine.pauseLecture(); await flush();
  await f.tick(1199);
  assert.equal(f.requests.some(request => request.body.action === "pause"), false);
  assert.equal(f.engine.isPausing, true);
  f.sockets[0].onmessage?.({ data: JSON.stringify({ type: "Results", is_final: true, speech_final: true, start: 0, duration: 1,
    channel: { alternatives: [{ transcript: "Last fallback sentence" }] } }) });
  await f.tick(1); await paused; await flush();
  assert.equal(f.engine.segments.at(-1)?.text, "Last fallback sentence");
  assert.equal(f.engine.isPausing, false);
});


test("an ambiguous pause 409 never confirms server state or allows resume before a successful retry", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  f.handle((_url, body) => body.action === "pause" ? Promise.resolve(response({ error: "Could not pause" }, 409)) : undefined);
  const paused = f.engine.pauseLecture(); await flush();
  f.sockets[0].close(); await flush(); await f.tick(1200); await paused;
  assert.equal(f.engine.status, "paused");
  assert.equal(f.inputs[0].disposed, true);
  assert.equal(await f.engine.resumeLecture(), false);
  assert.equal(f.requests.some(request => request.body.action === "resume"), false);
  assert.ok(f.notices.at(-1)?.includes("일시정지"));
  f.handle(null);
  await f.tick(30000);
  const resumed = f.engine.resumeLecture(); await flush(); await f.sockets[1].open();
  assert.equal(await resumed, true); await flush();
  assert.equal(f.engine.status, "recording");
});

test("a pending pause 409 still permits a confirmed final save", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  f.handle((_url, body) => body.action === "pause" ? Promise.resolve(response({ error: "Could not pause" }, 409)) : undefined);
  const paused = f.engine.pauseLecture(); await flush();
  f.sockets[0].close(); await flush(); await f.tick(1200); await paused;
  assert.equal(await f.engine.resumeLecture(), false);
  const ending = f.engine.finishLecture(); await flush(); await f.tick(1200); await ending; await flush();
  assert.equal(f.engine.status, "ended");
  assert.equal(f.engine.isFinalizing, false);
  assert.equal(f.savedSessions.length, 1);
  assert.equal(f.mirror.size, 0);
  const pauses = f.requests.filter(request => request.body.action === "pause").length;
  await f.tick(30000);
  assert.equal(f.requests.filter(request => request.body.action === "pause").length, pauses, "final save retires the pending pause retry");
});


test("a late old-session pause ACK cannot clear a newer session's pending pause or saved clock", async t => {
  const f = fixture(t);
  const { pending } = await f.start(); await f.sockets[0].open(); await pending; await flush();
  const oldAck = deferred<Response>();
  let oldPauses = 0;
  f.handle((_url, body) => {
    if (body.action !== "pause") return;
    if (body.sessionId === "session-1" && oldPauses++ > 0) return oldAck.promise;
    return Promise.resolve(response({ error: "Save unavailable" }, 503));
  });
  const oldPause = f.engine.pauseLecture(); await flush(); f.sockets[0].close(); await flush(); await f.tick(1200); await oldPause;
  await f.tick(30000); // Retry of the earlier pause is still awaiting its ACK.
  f.engine.activeSessionIdRef.current = "new-session";
  f.engine.elapsedBaseMsRef.current = 2000;
  f.engine.setStatus("recording"); await flush();
  const newPause = f.engine.pauseLecture(); await flush(); await f.tick(1200); await newPause;
  assert.equal(f.engine.elapsedMs, 2000);
  const newNotice = f.notices.at(-1);
  oldAck.resolve(response({ status: "paused", recordedMs: 900000 })); await flush();
  assert.equal(f.engine.elapsedMs, 2000);
  assert.equal(f.notices.at(-1), newNotice);
  assert.equal(await f.engine.resumeLecture(), false);
  assert.equal(f.requests.some(request => request.body.action === "resume"), false);
});
