import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { decodePhoneFrame, encodePhoneFrame } from "./phone-mic-wire.ts";
import type { PcmRecorder } from "../classroom/pcm-recorder.ts";

let createCapture: (stream: MediaStream, onData: (pcm: ArrayBuffer) => void, onStop: () => void | Promise<void>) => Promise<PcmRecorder>;
mock.module(pathToFileURL("app/classroom/pcm-recorder.ts").href, { namedExports: {
  createPcmRecorder: (...args: Parameters<typeof createCapture>) => createCapture(...args),
} });
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    try { return nextResolve(`${specifier}.ts`, context); } catch { throw error; }
  }
} });
const { createDesktopPhoneMic, createPhoneMicrophone } = await import("./phone-mic-client.ts");
const roomId = "11111111-1111-4111-8111-111111111111";
const secret = "a".repeat(43);
const relayUrl = `wss://phone.example/v1/rooms/${roomId}/socket`;
const storageKey = `lecue-phone-mic:${roomId}`;
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_800_000_000_000 });
  const sockets: Socket[] = [], streams: MediaStream[] = [], locks: Array<{ released: boolean; release(): Promise<void> }> = [];
  const captures: Array<PcmRecorder & { push(bytes: number): void; stopGate?: Promise<void>; stops: number }> = [];
  const storage = new Map<string, string>(), requests: Array<Record<string, unknown>> = [], replaced: unknown[] = [];
  const cleanups: Array<() => void> = [];
  let permission: (() => Promise<MediaStream>) | null = null;
  let startGate: Promise<void> | null = null;
  let claim: ((body: Record<string, unknown>) => Promise<Response>) | null = null;
  let wakeRequest: (() => Promise<WakeLockSentinel>) | null = null;
  class Socket {
    static OPEN = 1;
    readyState = 0; bufferedAmount = 0;
    readonly sent: Array<string | ArrayBuffer> = [];
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
    onerror: (() => void) | null = null;
    readonly url: string;
    readonly protocols: string[];
    constructor(url: string, protocols: string[]) { this.url = url; this.protocols = protocols; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(value: string | ArrayBuffer) { if (this.readyState !== 1) throw new Error("Closed"); this.sent.push(value); }
    receive(value: unknown) { this.onmessage?.({ data: value instanceof ArrayBuffer ? value : JSON.stringify(value) }); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
    controls(type?: string) { return this.sent.filter((frame): frame is string => typeof frame === "string").map(frame => JSON.parse(frame)).filter(frame => !type || frame.type === type); }
    frames() { return this.sent.filter((frame): frame is ArrayBuffer => frame instanceof ArrayBuffer).map(frame => decodePhoneFrame(frame)!); }
  }
  function stream() {
    const track = { readyState: "live", onended: null as (() => void) | null, stop() { this.readyState = "ended"; } };
    const result = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    streams.push(result); return result;
  }
  function lock() {
    const result = { released: false, async release() { this.released = true; } };
    locks.push(result); return result as unknown as WakeLockSentinel;
  }
  const response = () => Response.json({ roomId, ownerToken: secret, inviteToken: secret, relayUrl, expiresAt: new Date(Date.now() + 60_000).toISOString(), inviteExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  const values = {
    WebSocket: Socket,
    navigator: { mediaDevices: { getUserMedia: () => permission ? permission() : Promise.resolve(stream()) }, wakeLock: { request: () => wakeRequest ? wakeRequest() : Promise.resolve(lock()) } },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    history: { replaceState: (...args: unknown[]) => replaced.push(args) }, location: { pathname: "/phone-mic", search: "" },
    fetch: async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); requests.push(body); return body.action === "claim" && claim ? claim(body) : response(); },
  };
  const saved = Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  createCapture = async (_stream, onData, onStop) => {
    let stopping: Promise<void> | null = null;
    const capture: (typeof captures)[number] = { state: "recording", stops: 0,
      push(bytes) { onData(new ArrayBuffer(bytes)); },
      stop() {
        if (stopping) return stopping;
        capture.state = "stopping"; capture.stops++;
        stopping = (async () => { await capture.stopGate; capture.push(100); capture.state = "inactive"; await onStop(); })();
        return stopping;
      },
    };
    captures.push(capture); await startGate; return capture;
  };
  t.after(async () => {
    for (const cleanup of cleanups) cleanup(); await flush();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  return { sockets, streams, captures, storage, requests, locks, replaced, response, stream, lock,
    permission(value: typeof permission) { permission = value; }, start(value: Promise<void> | null) { startGate = value; },
    claim(value: typeof claim) { claim = value; }, wake(value: typeof wakeRequest) { wakeRequest = value; },
    async tick(ms: number) { t.mock.timers.tick(ms); await flush(); },
    phone(invite: string | null = secret) { const phone = createPhoneMicrophone(roomId, invite, "ko"); cleanups.push(() => phone.dispose()); return phone; },
    async desktop() { const desktop = await createDesktopPhoneMic("ko", () => {}); cleanups.push(() => desktop.dispose()); return desktop; },
  };
}

test("claim persists the same phone token before the request and reuses it after response loss and reload", async t => {
  const f = fixture(t);
  let count = 0;
  f.claim(async body => {
    assert.equal(JSON.parse(f.storage.get(storageKey)!).token, body.phoneToken, "persist before server can claim the invite");
    if (++count === 1) throw new TypeError("Lost claim response");
    return f.response();
  });
  const first = f.phone(); await first.connect();
  assert.equal(first.getSnapshot().phase, "error");
  assert.equal(f.replaced.length, 0, "the invite remains available until a confirmed response");
  first.dispose();
  const reloaded = f.phone(); await reloaded.connect();
  assert.equal(reloaded.getSnapshot().phase, "ready");
  assert.equal(f.requests[0].phoneToken, f.requests[1].phoneToken);
  assert.equal(f.sockets[0].protocols[2], f.requests[0].phoneToken);
  assert.equal(f.replaced.length, 1);
});

test("phone start is idempotent and reconnect replays only unacknowledged PCM", async t => {
  const f = fixture(t), phone = f.phone(); await phone.connect();
  const first = f.sockets[0]; first.open(); first.receive({ type: "hello", peerConnected: true });
  first.receive({ type: "start", captureId: 7 }); await flush();
  f.captures[0].push(200); first.receive({ type: "ack", captureId: 7, sequence: 0 });
  f.captures[0].push(300);
  first.receive({ type: "start", captureId: 7 }); await flush();
  f.captures[0].push(400);
  assert.deepEqual(first.frames().map(frame => [frame.sequence, frame.pcm.byteLength]), [[0, 200], [1, 300], [2, 400]]);
  assert.equal(f.captures.length, 1);
  first.close(1006); await f.tick(750);
  const second = f.sockets[1]; second.open(); second.receive({ type: "hello", peerConnected: true }); await flush();
  assert.deepEqual(second.frames().map(frame => frame.sequence), [1, 2]);
  assert.equal(second.controls("ready").length, 1);
});

test("phone stop waits for final PCM acknowledgements and duplicate stop does not restart capture", async t => {
  const f = fixture(t), phone = f.phone(); await phone.connect();
  const socket = f.sockets[0]; socket.open(); socket.receive({ type: "start", captureId: 8 }); await flush();
  f.captures[0].push(200);
  socket.receive({ type: "stop", captureId: 8 }); await flush();
  assert.equal(socket.controls("stopped").length, 0);
  assert.deepEqual(socket.frames().map(frame => frame.pcm.byteLength), [200, 100]);
  socket.receive({ type: "ack", captureId: 8, sequence: 1 }); await f.tick(30);
  assert.equal(socket.controls("stopped").length, 1);
  assert.equal(phone.getSnapshot().phase, "paused");
  socket.receive({ type: "stop", captureId: 8 }); await flush();
  assert.equal(socket.controls("stopped").length, 2);
  assert.equal(f.captures[0].stops, 1);
  socket.receive({ type: "peer", connected: true }); await flush();
  assert.equal(socket.controls("ready").length, 1, "a paused phone remains ready to resume after reconnect");
  socket.receive({ type: "start", captureId: 9 }); await flush();
  assert.equal(f.captures.length, 2);
});

test("desktop deduplicates replayed PCM and rejects a stop timeout while still draining STT", async t => {
  const f = fixture(t), desktop = await f.desktop();
  const socket = f.sockets[0]; socket.open(); socket.receive({ type: "ready" });
  const received: number[] = []; let drained = 0;
  const pending = desktop.source.start(pcm => received.push(pcm.byteLength), () => { drained++; }, () => {});
  const id = socket.controls("start")[0].captureId;
  socket.receive({ type: "started", captureId: id }); const recorder = await pending;
  const frame = encodePhoneFrame(id, 0, new ArrayBuffer(200));
  socket.receive(frame); socket.receive(frame);
  assert.deepEqual(received, [200]);
  assert.deepEqual(socket.controls("ack").map(control => control.sequence), [0, 0]);
  const stopped = assert.rejects(recorder.stop());
  await f.tick(2_500); await stopped;
  assert.equal(drained, 1);
  assert.equal(recorder.state, "inactive");
  assert.equal(desktop.source.isLive(), false);
  assert.equal(desktop.getSnapshot().phase, "error");
});

test("the phone pause button stops local capture promptly while preserving its final flush", async t => {
  const f = fixture(t), phone = f.phone(); await phone.connect();
  const socket = f.sockets[0]; socket.open(); socket.receive({ type: "start", captureId: 10 }); await flush();
  phone.pause(); await flush();
  assert.equal(f.captures[0].state, "inactive", "do not wait for a laptop round trip to stop capturing");
  assert.equal(socket.controls("pause").length, 1);
  assert.equal(socket.frames()[0].pcm.byteLength, 100, "the worklet tail is retained");
  socket.receive({ type: "ack", captureId: 10, sequence: 0 }); await f.tick(30);
  socket.receive({ type: "stop", captureId: 10 }); await flush();
  assert.equal(socket.controls("stopped").length, 2, "the later laptop stop receives an idempotent acknowledgement");
  assert.equal(f.captures[0].stops, 1);
});

test("desktop stop accepts its matching acknowledgement and delivers the final PCM first", async t => {
  const f = fixture(t), desktop = await f.desktop();
  const socket = f.sockets[0]; socket.open(); socket.receive({ type: "ready" });
  const order: string[] = [];
  const pending = desktop.source.start(() => order.push("pcm"), () => { order.push("drained"); }, () => {});
  const id = socket.controls("start")[0].captureId;
  socket.receive({ type: "started", captureId: id }); const recorder = await pending;
  const stop = recorder.stop();
  socket.receive({ type: "stopped", captureId: id + 1 }); await flush();
  assert.deepEqual(order, []);
  socket.receive(encodePhoneFrame(id, 0, new ArrayBuffer(100)));
  socket.receive({ type: "stopped", captureId: id }); await stop;
  assert.deepEqual(order, ["pcm", "drained"]);
  assert.equal(desktop.getSnapshot().phase, "paused");
});

test("disconnect during claim ignores its late response without closing a new connection", async t => {
  const f = fixture(t), phone = f.phone(), pendingClaim = deferred<Response>();
  let claims = 0; f.claim(() => ++claims === 1 ? pendingClaim.promise : Promise.resolve(f.response()));
  const old = phone.connect(); await flush();
  phone.disconnect(); await flush();
  await phone.connect(); const socket = f.sockets[0]; socket.open();
  pendingClaim.resolve(f.response()); await old; await flush();
  assert.equal(f.sockets.length, 1);
  assert.equal(socket.readyState, 1);
  assert.equal(f.streams[1].getTracks()[0].readyState, "live");
  assert.equal(phone.getSnapshot().phase, "ready");
  assert.equal(f.replaced.length, 1);
});

test("late old media cleanup and wake-lock acquisition cannot release the new connection", async t => {
  const f = fixture(t), phone = f.phone(), oldWake = deferred<WakeLockSentinel>();
  f.wake(() => oldWake.promise);
  const old = phone.connect(); await flush();
  const delayedStop = deferred<void>(); f.captures[0].stopGate = delayedStop.promise;
  phone.disconnect();
  f.wake(null); await phone.connect();
  const newLock = f.locks[0];
  const abandonedLock = f.lock(); oldWake.resolve(abandonedLock); await old;
  delayedStop.resolve(); await flush();
  assert.equal(f.streams[0].getTracks()[0].readyState, "ended");
  assert.equal(f.streams[1].getTracks()[0].readyState, "live");
  assert.equal(newLock.released, false);
  assert.equal(f.locks[1].released, true);
});

test("late capture creation and queued controls after disconnect cannot create or alter another attempt", async t => {
  const f = fixture(t), phone = f.phone(), oldCapture = deferred<void>();
  f.start(oldCapture.promise);
  const old = phone.connect(); await flush(); phone.disconnect();
  f.start(null); await phone.connect();
  const socket = f.sockets[0]; socket.open();
  oldCapture.resolve(); await old; await flush();
  assert.equal(f.captures[0].state, "inactive");
  assert.equal(f.captures[1].state, "recording");
  assert.equal(f.requests.length, 1, "a stale capture must never claim its invite");
  socket.receive({ type: "start", captureId: 14 });
  socket.receive({ type: "status", state: "recording", elapsedMs: 123 });
  phone.disconnect(); await flush();
  assert.equal(socket.controls("started").length, 0);
  assert.equal(phone.getSnapshot().phase, "ended");
  assert.equal(phone.getSnapshot().elapsedMs, 0);
});

test("a pending resume capture cannot send started after disconnect or replace the next recorder", async t => {
  const f = fixture(t), phone = f.phone(); await phone.connect();
  const socket = f.sockets[0]; socket.open(); socket.receive({ type: "start", captureId: 15 }); await flush();
  socket.receive({ type: "stop", captureId: 15 }); await flush();
  socket.receive({ type: "ack", captureId: 15, sequence: 0 }); await f.tick(30);
  const delayed = deferred<void>(); f.start(delayed.promise);
  socket.receive({ type: "start", captureId: 16 }); await flush();
  phone.disconnect(); f.start(null); await phone.connect();
  delayed.resolve(); await flush();
  assert.deepEqual(socket.controls("started").map(control => control.captureId), [15]);
  assert.equal(f.captures[1].state, "inactive");
  assert.equal(f.captures[2].state, "recording");
  assert.equal(phone.getSnapshot().phase, "ready");
});

test("desktop disposal rejects an in-flight start and cannot be revived by late acknowledgements", async t => {
  const f = fixture(t), desktop = await f.desktop();
  const socket = f.sockets[0]; socket.open(); socket.receive({ type: "ready" });
  let stopped = 0;
  const start = assert.rejects(desktop.source.start(() => {}, () => { stopped++; }, () => {}));
  desktop.dispose(); await start; await flush();
  socket.receive({ type: "ready" });
  assert.equal(desktop.getSnapshot().phase, "ended");
  assert.equal(desktop.source.isLive(), false);
  assert.equal(stopped, 1);
});
