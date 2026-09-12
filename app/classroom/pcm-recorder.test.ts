import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { createPcmRecorder } from "./pcm-recorder.ts";

type PortData = ArrayBuffer | { type: string };
type Port = { onmessage: ((event: { data: PortData }) => void) | null; postMessage(data: PortData, transfer?: ArrayBuffer[]): void };

function fixture(t: TestContext, onStop: () => void | Promise<void>, ignoreFlush = false) {
  const saved = ["AudioContext", "AudioWorkletNode"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages: PortData[] = [];
  const commands: PortData[] = [];
  const bytes: ArrayBuffer[] = [];
  let closed = 0;
  let Processor!: new () => { port: Port; process(inputs: Float32Array[][]): boolean };
  runInNewContext(readFileSync(new URL("../../public/pcm-capture-worklet.js", import.meta.url), "utf8"), {
    Float32Array,
    AudioWorkletProcessor: class {
      port: Port = {
        onmessage: null,
        postMessage(data, transfer = []) { messages.push(structuredClone(data, { transfer })); },
      };
    },
    registerProcessor(_name: string, constructor: typeof Processor) { Processor = constructor; },
  });
  const processor = new Processor();
  const capturePort: Port = {
    onmessage: null,
    postMessage(data) {
      commands.push(data);
      if (!ignoreFlush) processor.port.onmessage?.({ data });
    },
  };
  const node = () => ({ connect() {}, disconnect() {} });
  Object.defineProperties(globalThis, {
    AudioContext: { configurable: true, value: class {
      sampleRate = 16_000;
      audioWorklet = { async addModule() {} };
      destination = {};
      createMediaStreamSource = node;
      createGain() { return { ...node(), gain: { value: 1 } }; }
      async resume() {}
      async close() { closed++; }
    } },
    AudioWorkletNode: { configurable: true, value: class {
      port = capturePort;
      connect() {}
      disconnect() {}
    } },
  });
  return {
    open: () => createPcmRecorder({} as MediaStream, data => bytes.push(data), onStop),
    process: (samples: Float32Array) => processor.process([[samples]]),
    deliver() {
      const data = messages.shift();
      assert.ok(data, "expected a worklet message");
      capturePort.onmessage?.({ data });
    },
    bytes, commands,
    closed: () => closed,
  };
}

test("stop delivers the worklet tail before waiting for asynchronous transport drain", async t => {
  const events: string[] = [];
  let releaseDrain!: () => void;
  const drain = new Promise<void>(resolve => { releaseDrain = resolve; });
  const f = fixture(t, async () => {
    events.push("draining");
    assert.deepEqual(f.bytes.map(bytes => bytes.byteLength), [8192, 256]);
    await drain;
    events.push("drained");
  });
  const recorder = await f.open();
  f.process(new Float32Array(4096).fill(0.5));
  f.deliver();
  f.process(new Float32Array(128).fill(-0.5));
  const stopped = recorder.stop();
  assert.equal(recorder.stop(), stopped);
  assert.equal(recorder.state, "stopping");
  assert.deepEqual(f.commands, [{ type: "flush" }]);
  let settled = false;
  void stopped.then(() => { settled = true; });
  f.deliver(); // The actual worklet posts tail PCM before its acknowledgement.
  assert.deepEqual(f.bytes.map(bytes => bytes.byteLength), [8192, 256]);
  assert.equal(new DataView(f.bytes[1]).getInt16(0, true), -16384);
  assert.deepEqual(events, []);
  f.deliver();
  await Promise.resolve();
  assert.equal(recorder.state, "inactive");
  assert.equal(f.closed(), 1);
  assert.deepEqual(events, ["draining"]);
  assert.equal(settled, false);
  assert.equal(recorder.stop(), stopped);
  t.mock.timers.tick(1000);
  assert.deepEqual(events, ["draining"]);
  releaseDrain();
  await stopped;
  assert.deepEqual(events, ["draining", "drained"]);
  assert.equal(settled, true);
});

test("250 ms capture fallback still waits for asynchronous transport drain", async t => {
  let releaseDrain!: () => void;
  let drainCalls = 0;
  const drain = new Promise<void>(resolve => { releaseDrain = resolve; });
  const f = fixture(t, () => { drainCalls++; return drain; }, true);
  const recorder = await f.open();
  const stopped = recorder.stop();
  let settled = false;
  void stopped.then(() => { settled = true; });
  t.mock.timers.tick(249);
  assert.equal(recorder.state, "stopping");
  assert.equal(drainCalls, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(f.closed(), 1);
  assert.equal(drainCalls, 1);
  assert.equal(settled, false);
  assert.equal(recorder.stop(), stopped);
  releaseDrain();
  await stopped;
  assert.equal(settled, true);
  assert.equal(drainCalls, 1);
});

test("stop reports a failed transport drain to its caller", async t => {
  const error = new Error("transport drain failed");
  const f = fixture(t, async () => { throw error; });
  const recorder = await f.open();
  const stopped = recorder.stop();
  const rejected = assert.rejects(stopped, error);
  f.deliver();
  await rejected;
  assert.equal(recorder.stop(), stopped);
  assert.equal(f.closed(), 1);
});
