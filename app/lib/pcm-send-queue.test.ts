import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { PcmSendQueue, PCM_BYTES_PER_SECOND, PCM_PENDING_MAX_MS } from "./pcm-send-queue.ts";

const { bridge } = createRequire(import.meta.url)("../../workers/stt-relay/index.mjs");
class Socket {
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  closes: number[] = [];
  listeners = new Map<string, ((event: { data: string | ArrayBuffer }) => void)[]>();
  addEventListener(type: string, listener: (event: { data: string | ArrayBuffer }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(bytes: string | ArrayBuffer) { this.sent.push(bytes); }
  close(code: number) { this.closes.push(code); }
  receive(data: string | ArrayBuffer) { for (const listener of this.listeners.get("message") ?? []) listener({ data }); }
}
function relay() {
  const client = new Socket(), upstream = new Socket();
  let time = 0;
  const controls: { action: string; processedBytes: number }[] = [];
  const timers = { setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {} };
  const state = bridge({ client, upstream, configuration: { provider: "deepgram" },
    grant: { baseBytes: 0, authorizedBytes: 1920000, leaseMs: 20000 }, connectionId: "fixture", now: () => time, timers,
    invoke: async (body: { action: string; processedBytes: number }) => { controls.push(body); return { authorizedBytes: 1920000, leaseMs: 20000 }; },
  });
  return { client, upstream, controls, state, setTime(value: number) { time = value; },
    sender: { bufferedAmount: 0, send: (bytes: ArrayBuffer) => client.receive(bytes) } };
}

for (const setupSeconds of [5, 10]) {
  test(`${setupSeconds}-second setup/reconnect queue preserves every frame and obeys the actual relay rate limit`, async () => {
    const queue = new PcmSendQueue();
    const expected: Buffer[] = [];
    let sequence = 0;
    function capture() {
      const bytes = new ArrayBuffer(3200);
      new Uint8Array(bytes).fill(sequence++);
      expected.push(Buffer.from(bytes));
      queue.push(bytes);
    }
    for (let frame = 0; frame < setupSeconds * 10; frame++) capture();
    assert.equal(queue.takeDroppedBytes(), 0);
    const f = relay();
    queue.startConnection(0);
    queue.drain(f.sender, 0); await f.state.settled();
    for (let time = 100; time <= 5000; time += 100) {
      f.setTime(time); capture(); queue.drain(f.sender, time); await f.state.settled();
    }
    // Stop capture, but drain retained speech before the provider's CloseStream.
    assert.ok(queue.byteLength > 0);
    for (let time = 5100; queue.byteLength && time < 19000; time += 100) {
      f.setTime(time); queue.drain(f.sender, time); await f.state.settled();
    }
    assert.equal(queue.byteLength, 0);
    f.client.receive('{"type":"CloseStream"}'); await f.state.settled();
    assert.deepEqual(f.client.closes, []);
    assert.equal(f.upstream.sent.at(-1), '{"type":"CloseStream"}');
    assert.deepEqual(Buffer.concat(f.upstream.sent.filter((data): data is ArrayBuffer => data instanceof ArrayBuffer).map(bytes => Buffer.from(bytes))), Buffer.concat(expected));
    assert.equal(queue.takeDroppedBytes(), 0);
    f.state.finish();
    assert.equal(f.controls.at(-1)?.processedBytes, Buffer.concat(expected).byteLength);
  });
}

test("a long outage stays bounded and reports only the exact bytes actually discarded once", () => {
  const queue = new PcmSendQueue();
  const kept = new Uint8Array(PCM_BYTES_PER_SECOND * 40);
  kept.fill(1, 0, PCM_BYTES_PER_SECOND * 10);
  kept.fill(2, PCM_BYTES_PER_SECOND * 10);
  queue.push(kept.buffer);
  assert.equal(queue.durationMs, PCM_PENDING_MAX_MS);
  assert.equal(queue.takeDroppedBytes(), PCM_BYTES_PER_SECOND * 10);
  assert.equal(queue.takeDroppedBytes(), 0);
  const frames: ArrayBuffer[] = [];
  queue.startConnection(0);
  for (let time = 0; queue.byteLength; time += 100) queue.drain({ bufferedAmount: 0, send: bytes => frames.push(bytes) }, time);
  assert.deepEqual(Buffer.concat(frames.map(frame => Buffer.from(frame))), Buffer.alloc(PCM_BYTES_PER_SECOND * 30, 2));
});

test("backpressure and a failed send retain PCM; a resumed socket uses a fresh rate budget", () => {
  const queue = new PcmSendQueue();
  queue.push(new ArrayBuffer(160000));
  queue.startConnection(0);
  const full = { bufferedAmount: 32000, send() { throw new Error("must not send"); } };
  assert.equal(queue.drain(full, 100), 0);
  assert.throws(() => queue.drain({ bufferedAmount: 0, send() { throw new Error("closed"); } }, 200));
  assert.equal(queue.byteLength, 160000);
  assert.equal(queue.takeDroppedBytes(), 0);
  queue.startConnection(10000);
  assert.equal(queue.drain({ bufferedAmount: 0, send() {} }, 10000), 48000);
  assert.equal(queue.drain({ bufferedAmount: 0, send() {} }, 10000), 0);
  assert.equal(queue.drain({ bufferedAmount: 0, send() {} }, 10100), 3200);
});

test("clearing a completed session cannot leave a stale loss notice for the next recording", () => {
  const queue = new PcmSendQueue();
  queue.push(new ArrayBuffer(PCM_BYTES_PER_SECOND * 31));
  queue.clear();
  assert.equal(queue.byteLength, 0);
  assert.equal(queue.takeDroppedBytes(), 0);
  queue.push(new ArrayBuffer(3200)); queue.discard();
  assert.equal(queue.byteLength, 0);
  assert.equal(queue.takeDroppedBytes(), 3200);
});
