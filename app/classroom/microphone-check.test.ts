import assert from "node:assert/strict";
import test from "node:test";
import { startMicrophoneCheck } from "./microphone-check.ts";

type Failure = "permission" | "constructor" | "analyser" | "source" | "connect" | "resume" | "disconnect" | "close" | null;
let failure: Failure;
let events: string[];
let requests: unknown[];
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let sampleByte: number;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

test.beforeEach(() => {
  failure = null; events = []; requests = []; frames = new Map(); nextFrame = 0; sampleByte = 128;
  const tracks = ["audio", "secondary"].map(label => ({ label, stop: () => { events.push(`stop:${label}`); } }));
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks.slice(0, 1) };
  class FakeAudioContext {
    constructor() { if (failure === "constructor") throw new Error("constructor"); events.push("context"); }
    createAnalyser() {
      if (failure === "analyser") throw new Error("analyser");
      return { fftSize: 0, getByteTimeDomainData: (bytes: Uint8Array) => bytes.fill(sampleByte) };
    }
    createMediaStreamSource(received: unknown) {
      assert.equal(received, stream);
      if (failure === "source") throw new Error("source");
      return {
        connect: () => { if (failure === "connect") throw new Error("connect"); events.push("connect"); },
        disconnect: () => { events.push("disconnect"); if (failure === "disconnect") throw new Error("disconnect"); },
      };
    }
    async resume() { events.push("resume"); if (failure === "resume") throw new Error("resume"); }
    async close() { events.push("close"); if (failure === "close") throw new Error("close"); }
  }
  const replacements = {
    navigator: { mediaDevices: { getUserMedia: async (constraints: unknown) => {
      requests.push(constraints);
      if (failure === "permission") throw new Error("permission");
      return stream;
    } } },
    AudioContext: FakeAudioContext,
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => { events.push(`cancel:${id}`); frames.delete(id); },
  };
  for (const [name, value] of Object.entries(replacements)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
});

test.afterEach(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
});

test("microphone level checking uses the selected input, reports bounded levels, and releases every resource on stop", async () => {
  const levels: number[] = [];
  const check = await startMicrophoneCheck("chosen-mic", level => levels.push(level));
  assert.deepEqual(requests, [{ audio: { deviceId: { exact: "chosen-mic" } } }]);
  assert.equal(check.label, "audio");
  assert.deepEqual(levels, [0]);
  const staleFrame = frames.get(nextFrame)!;
  frames.delete(nextFrame);
  sampleByte = 255;
  staleFrame(0);
  assert.deepEqual(levels, [0, 1]);
  assert.equal(frames.size, 1);
  check.stop();
  check.stop();
  staleFrame(0);
  assert.equal(frames.size, 0);
  assert.deepEqual(levels, [0, 1], "a queued callback after close must not sample or re-arm the loop");
  for (const resource of ["disconnect", "stop:audio", "stop:secondary", "close"]) {
    assert.equal(events.filter(event => event === resource).length, 1, `${resource} runs exactly once`);
  }
});

test("the default microphone is requested without an exact device constraint", async () => {
  const check = await startMicrophoneCheck("", () => {});
  assert.deepEqual(requests, [{ audio: true }]);
  check.stop();
});

test("a denied microphone request creates no audio context or sampling loop", async () => {
  failure = "permission";
  await assert.rejects(startMicrophoneCheck("", () => {}), /permission/);
  assert.deepEqual(events, []);
  assert.equal(frames.size, 0);
});

for (const stage of ["constructor", "analyser", "source", "connect", "resume"] as const) {
  test(`a ${stage} failure releases the acquired microphone and any created audio context`, async () => {
    failure = stage;
    await assert.rejects(startMicrophoneCheck("", () => {}), new RegExp(stage));
    assert.equal(events.filter(event => event === "stop:audio").length, 1);
    assert.equal(events.filter(event => event === "stop:secondary").length, 1);
    assert.equal(events.filter(event => event === "close").length, stage === "constructor" ? 0 : 1);
    assert.equal(frames.size, 0);
  });
}

test("disconnect failure cannot leave the microphone or audio context open", async () => {
  const check = await startMicrophoneCheck("", () => {});
  failure = "disconnect";
  assert.doesNotThrow(() => check.stop());
  assert.ok(events.includes("stop:audio"));
  assert.ok(events.includes("stop:secondary"));
  assert.ok(events.includes("close"));
  assert.equal(frames.size, 0);
});

test("an AudioContext close rejection does not prevent microphone tracks from stopping", async () => {
  const check = await startMicrophoneCheck("", () => {});
  failure = "close";
  assert.doesNotThrow(() => check.stop());
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.includes("stop:audio"));
  assert.ok(events.includes("stop:secondary"));
  assert.equal(frames.size, 0);
});
