import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveScriptController, LIVE_SCRIPT_CACHE_KEY, type LiveScriptInput, type LiveScriptSegment } from "./live-script-client.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const segment = (index: number, text = `원본 발화 ${index}입니다.`): LiveScriptSegment => ({ id: `${index}-${text}`, startMs: index * 1_000, endMs: index * 1_000 + 900, text });
type Call = { ids: string[]; body: Record<string, unknown>; signal: AbortSignal; headers: Headers };
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function harness(options: { respond?: (call: Call, index: number) => Response | Promise<Response>; storage?: ReturnType<typeof memoryStorage>; input?: Partial<LiveScriptInput> } = {}) {
  let time = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const calls: Call[] = [];
  let input: LiveScriptInput = { sessionId: "session-a", segments: [], status: "recording", locale: "ko", ...options.input };
  const response = (call: Call) => {
    const selected = input.segments.filter((item) => call.ids.includes(item.id));
    return Response.json({ segmentIds: call.ids, startMs: Math.min(...selected.map((item) => item.startMs)),
      endMs: Math.max(...selected.map((item) => item.endMs)), text: "군더더기를 덜어낸 발화입니다.", keywords: ["핵심어"] });
  };
  const controller = createLiveScriptController({
    now: () => time, storage: () => options.storage ?? null,
    setTimer(callback, milliseconds) { const handle = ++sequence; timers.set(handle, { at: time + milliseconds, callback }); return handle; },
    clearTimer(handle) { timers.delete(handle as number); },
    fetcher: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const call = { ids: body.segmentIds as string[], body, signal: init?.signal as AbortSignal, headers: new Headers(init?.headers) };
      calls.push(call);
      return options.respond ? options.respond(call, calls.length) : response(call);
    }) as typeof fetch,
  });
  controller.update(input);
  return {
    controller, calls, response, timers,
    update(patch: Partial<LiveScriptInput>) { input = { ...input, ...patch }; controller.update(input); },
    async advance(milliseconds: number) {
      const target = time + milliseconds;
      let executions = 0;
      for (;;) {
        await flush();
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++executions < 200, "no immediate request/retry storm");
        timers.delete(next[0]); time = next[1].at; next[1].callback();
      }
      time = target;
      await flush();
    },
  };
}

test("first final speech settles within 1.5 seconds even under continuous updates", async () => {
  const h = harness();
  const sources: LiveScriptSegment[] = [];
  for (let index = 0; index < 5; index++) {
    sources.push(segment(index)); h.update({ segments: [...sources] });
    await h.advance(300);
  }
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].ids, sources.map((item) => item.id));
  assert.deepEqual(Object.keys(h.calls[0].body).sort(), ["segmentIds", "sessionId"]);
  assert.equal(h.calls[0].headers.get("X-Site-Locale"), "ko");
  assert.equal(h.controller.getSnapshot().entries.length, 1);
  h.controller.dispose();
});

test("new final speech appends stable rows at five-second cadence without replay", async () => {
  const h = harness({ input: { segments: [segment(0)] } });
  await h.advance(1_500);
  const first = h.controller.getSnapshot().entries[0];
  h.update({ segments: [segment(0), segment(1), segment(1)] });
  await h.advance(4_999);
  assert.equal(h.calls.length, 1);
  await h.advance(1);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].ids, [segment(1).id]);
  assert.equal(h.controller.getSnapshot().entries[0], first, "earlier rows are not rewritten");
  h.update({ segments: [segment(0), segment(1)].map((item) => ({ ...item })) });
  await h.advance(30_000);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("batching bounds source count and text without silently dropping long segments", async () => {
  const h = harness({ input: { segments: Array.from({ length: 40 }, (_, index) => segment(index)) } });
  await h.advance(1_500);
  assert.equal(h.calls[0].ids.length, 16);
  await h.advance(10_000);
  assert.deepEqual(h.calls.map((call) => call.ids.length), [16, 16, 8]);
  h.controller.dispose();
  const textBound = harness({ input: { segments: [segment(0, "a".repeat(1_300)), segment(1, "b".repeat(1_300)), segment(2, "c".repeat(3_000))] } });
  await textBound.advance(11_500);
  assert.deepEqual(textBound.calls.map((call) => call.ids.length), [1, 1, 1]);
  textBound.controller.dispose();
});

test("popover subscribers may come and go without stopping processing", async () => {
  const h = harness({ input: { segments: [segment(0)] } });
  const unsubscribe = h.controller.subscribe(() => {});
  unsubscribe();
  await h.advance(1_500);
  h.update({ segments: [segment(0), segment(1)] });
  await h.advance(5_000);
  assert.equal(h.controller.getSnapshot().entries.length, 2);
  h.controller.dispose();
});

test("pause and end flush new tail immediately, while backlog retains bounded cadence", async () => {
  for (const status of ["paused", "ended", "error"]) {
    const h = harness({ input: { segments: [segment(0)] } });
    await h.advance(1_500);
    h.update({ segments: [segment(0), segment(1)], status });
    await h.advance(0);
    assert.equal(h.calls.length, 2, status);
    h.controller.dispose();
  }
  const backlog = harness({ input: { status: "ended", segments: Array.from({ length: 40 }, (_, index) => segment(index)) } });
  await backlog.advance(0);
  assert.equal(backlog.calls.length, 1);
  await backlog.advance(4_999);
  assert.equal(backlog.calls.length, 1);
  await backlog.advance(1);
  assert.equal(backlog.calls.length, 2);
  backlog.controller.dispose();
});

test("draft and connecting states do not issue background requests", async () => {
  const h = harness({ input: { status: "idle", segments: [segment(0)] } });
  await h.advance(10_000);
  h.update({ status: "connecting" });
  await h.advance(10_000);
  assert.equal(h.calls.length, 0);
  h.update({ status: "recording" });
  await h.advance(0);
  assert.equal(h.calls.length, 1);
  h.controller.dispose();
});

test("at most one request runs while new speech queues behind it", async () => {
  let resolve!: (response: Response) => void;
  const h = harness({ input: { segments: [segment(0)] }, respond: (_call, index) => index === 1
    ? new Promise<Response>((done) => { resolve = done; }) : h.response(h.calls[index - 1]) });
  await h.advance(1_500);
  h.update({ segments: [segment(0), segment(1)] });
  await h.advance(10_000);
  assert.equal(h.calls.length, 1);
  resolve(h.response(h.calls[0]));
  await h.advance(0);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("session and locale switches abort old work and ignore late responses", async () => {
  for (const patch of [{ sessionId: "session-b" }, { locale: "en" as const }]) {
    let resolve!: (response: Response) => void;
    const h = harness({ input: { segments: [segment(0)] }, respond: () => new Promise<Response>((done) => { resolve = done; }) });
    await h.advance(1_500);
    const oldResponse = h.response(h.calls[0]);
    h.update({ ...patch, segments: [] });
    assert.equal(h.calls[0].signal.aborted, true);
    resolve(oldResponse);
    await h.advance(10_000);
    assert.deepEqual(h.controller.getSnapshot().entries, []);
    assert.equal(h.calls.length, 1);
    h.controller.dispose();
  }
});

test("dispose aborts request and cancels all future retries; strict-mode restart works", async () => {
  const h = harness({ input: { segments: [segment(0)] }, respond: () => new Promise<Response>(() => {}) });
  await h.advance(1_500);
  h.controller.dispose();
  assert.equal(h.calls[0].signal.aborted, true);
  await h.advance(60_000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
  h.controller.start(); h.update({ segments: [segment(0)] });
  await h.advance(0);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("request timeout releases a nonresponsive fetch without blocking recording updates", async () => {
  const h = harness({ input: { segments: [segment(0)] }, respond: () => new Promise<Response>(() => {}) });
  await h.advance(1_500);
  h.update({ segments: [segment(0), segment(1)] });
  await h.advance(20_000);
  assert.equal(h.calls[0].signal.aborted, true);
  await h.advance(1_000);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("409 and network failures retry finitely without consuming unprocessed speech", async () => {
  for (const failure of [() => new Response(null, { status: 409, headers: { "Retry-After": "2" } }), () => { throw new TypeError("private upstream payload"); }]) {
    const h = harness({ input: { segments: [segment(0)] }, respond: failure });
    await h.advance(60_000);
    assert.equal(h.calls.length, 4);
    assert.equal(h.controller.getSnapshot().phase, "error");
    assert.equal(h.controller.getSnapshot().entries.length, 0);
    assert.doesNotMatch(h.controller.getSnapshot().error ?? "", /private upstream/);
    h.update({ segments: [segment(0), segment(1)] });
    await h.advance(60_000);
    assert.equal(h.calls.length, 4, "new source cannot restart an exhausted retry storm");
    h.controller.retry();
    await h.advance(0);
    assert.equal(h.calls.length, 5);
    h.controller.dispose();
  }
});

test("429 Retry-After is honored even by manual retry and pause flushing", async () => {
  const h = harness({ input: { segments: [segment(0)] }, respond: () => new Response(null, { status: 429, headers: { "Retry-After": "30" } }) });
  await h.advance(1_500);
  h.controller.retry(); h.update({ status: "paused" });
  await h.advance(29_999);
  assert.equal(h.calls.length, 1);
  await h.advance(1);
  assert.equal(h.calls.length, 2);
  await h.advance(120_000);
  assert.equal(h.controller.getSnapshot().phase, "error");
  const count = h.calls.length;
  await h.advance(60_000);
  assert.equal(h.calls.length, count);
  h.controller.dispose();
});

test("permanent API failures expose retry without automatic repeated calls", async () => {
  const h = harness({ input: { segments: [segment(0)] }, respond: () => new Response(null, { status: 403 }) });
  await h.advance(60_000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().phase, "error");
  h.controller.dispose();
});

test("413 explains oversized speech without retry promises and preserves earlier processed entries", async () => {
  for (const locale of ["ko", "en"] as const) {
    const h = harness({ input: { locale, segments: [segment(0)] }, respond: (call, index) => index === 1
      ? h.response(call) : new Response("private upstream detail", { status: 413 }) });
    await h.advance(1_500);
    const first = h.controller.getSnapshot().entries[0];
    h.update({ segments: [segment(0), segment(1)] });
    await h.advance(60_000);
    const state = h.controller.getSnapshot();
    assert.equal(h.calls.length, 2, "oversized speech is not automatically retried");
    assert.equal(state.phase, "error");
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0], first);
    assert.match(state.error ?? "", locale === "ko" ? /너무 길어/ : /too long/);
    assert.doesNotMatch(state.error ?? "", /retry|다시 시도|private upstream/i);
    h.update({ segments: [segment(0), segment(1), segment(2)] });
    await h.advance(60_000);
    assert.equal(h.calls.length, 2, "new speech does not restart a terminal failure");
    h.controller.dispose();
  }
});

test("malformed or foreign source responses never enter the visible flow", async () => {
  const h = harness({ input: { segments: [segment(0)] }, respond: () => Response.json({ segmentIds: ["foreign"], startMs: 0, endMs: 900, text: "invented", keywords: [] }) });
  await h.advance(1_500);
  assert.equal(h.controller.getSnapshot().entries.length, 0);
  h.controller.dispose();
});

test("refresh restores cleaned entries and consumed fingerprints without raw source IDs", async () => {
  const storage = memoryStorage();
  const source = segment(0, "절대로_캐시에_복사하지_않는_원본_발화");
  const before = harness({ storage, input: { segments: [source] } });
  await before.advance(1_500);
  const original = before.controller.getSnapshot().entries;
  before.controller.dispose();
  const raw = storage.getItem(LIVE_SCRIPT_CACHE_KEY)!;
  assert.doesNotMatch(raw, /절대로_캐시에|segmentIds/);
  assert.match(raw, /군더더기를 덜어낸/);
  // Reopen at the same or later wall time; synthetic clocks start from zero.
  const parsed = JSON.parse(raw); parsed[0].at = 0;
  storage.setItem(LIVE_SCRIPT_CACHE_KEY, JSON.stringify(parsed));
  const after = harness({ storage, input: { segments: [source] } });
  assert.deepEqual(after.controller.getSnapshot().entries, original);
  await after.advance(30_000);
  assert.equal(after.calls.length, 0);
  after.update({ segments: [source, segment(1)] });
  await after.advance(1_500);
  assert.equal(after.calls.length, 1);
  assert.deepEqual(after.calls[0].ids, [segment(1).id]);
  after.controller.dispose();
});

test("cache is isolated by session and locale; corrupt or inaccessible storage is harmless", async () => {
  const storage = memoryStorage();
  const h = harness({ storage, input: { segments: [segment(0)] } });
  await h.advance(1_500);
  h.update({ sessionId: "other", segments: [] });
  assert.deepEqual(h.controller.getSnapshot().entries, []);
  h.update({ sessionId: "session-a", locale: "en", segments: [] });
  assert.deepEqual(h.controller.getSnapshot().entries, []);
  h.controller.dispose();
  for (const raw of ["not json", "{}", JSON.stringify([{ key: "session-a:ko", at: 0, entries: [null], consumed: [] }])]) {
    storage.setItem(LIVE_SCRIPT_CACHE_KEY, raw);
    const corrupt = harness({ storage, input: { segments: [segment(0)] } });
    await corrupt.advance(1_500);
    assert.equal(corrupt.controller.getSnapshot().entries.length, 1);
    corrupt.controller.dispose();
  }
  const inaccessible = createLiveScriptController({ storage: () => { throw new DOMException("denied"); } });
  assert.doesNotThrow(() => inaccessible.update({ sessionId: "x", locale: "ko", status: "idle", segments: [] }));
  inaccessible.dispose();
});

test("cache expires within a day and retains at most three recent session records", async () => {
  const storage = memoryStorage();
  const h = harness({ storage });
  for (const sessionId of ["a", "b", "c", "d"]) {
    h.update({ sessionId, segments: [segment(0)] });
    await h.advance(1_500);
  }
  const records = JSON.parse(storage.getItem(LIVE_SCRIPT_CACHE_KEY)!);
  assert.deepEqual(records.map((entry: { key: string }) => entry.key), ["b:ko", "c:ko", "d:ko"]);
  h.update({ sessionId: "away", segments: [] });
  await h.advance(24 * 60 * 60 * 1_000);
  h.update({ sessionId: "d", segments: [segment(0)] });
  assert.deepEqual(h.controller.getSnapshot().entries, []);
  await h.advance(1_500);
  assert.equal(h.calls.length, 5, "expired cleaned data is regenerated only when that session is opened");
  h.controller.dispose();
});

test("corrected persisted source invalidates only its cached passage", async () => {
  const storage = memoryStorage();
  const sources = [segment(0), segment(1)];
  const before = harness({ storage, input: { segments: [sources[0]] } });
  await before.advance(1_500);
  before.update({ segments: sources });
  await before.advance(5_000);
  const second = before.controller.getSnapshot().entries[1];
  before.controller.dispose();
  const records = JSON.parse(storage.getItem(LIVE_SCRIPT_CACHE_KEY)!); records[0].at = 0;
  storage.setItem(LIVE_SCRIPT_CACHE_KEY, JSON.stringify(records));
  const after = harness({ storage, input: { segments: [{ ...sources[0], text: "수정된 발화" }, sources[1]] } });
  assert.deepEqual(after.controller.getSnapshot().entries, [second]);
  await after.advance(1_500);
  assert.deepEqual(after.calls[0].ids, [sources[0].id]);
  assert.equal(after.controller.getSnapshot().entries.length, 2);
  assert.deepEqual(after.controller.getSnapshot().entries[1], second);
  after.controller.dispose();
});
