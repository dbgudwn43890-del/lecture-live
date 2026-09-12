import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test, { type TestContext } from "node:test";

import { LectureInputError, acquireLectureInput, waitForConsentedInput, wrapCapture, type LectureInput } from "./lecture-input.ts";

type FakeTrack = MediaStreamTrack & { stops: number };

function track(kind: "audio" | "video", settings: Record<string, unknown> = {}): FakeTrack {
  const fake = {
    kind,
    stops: 0,
    readyState: "live",
    enabled: true,
    getSettings: () => settings,
    stop() { fake.stops += 1; fake.readyState = "ended"; },
  };
  return fake as unknown as FakeTrack;
}

function stream(tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  } as unknown as MediaStream;
}

const createStream = (tracks: MediaStreamTrack[]) => stream(tracks as FakeTrack[]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function consentInput() {
  const video = track("video", { displaySurface: "browser" });
  const audio = track("audio");
  return { input: wrapCapture("browser-tab", stream([video, audio]), createStream), video, audio };
}

function stubGlobal(t: TestContext, name: "CaptureController" | "MediaRecorder", value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
}

test("tab capture keeps the original stream and hands STT an audio-only stream", () => {
  const video = track("video", { displaySurface: "browser" });
  const audio = track("audio");
  const input = wrapCapture("browser-tab", stream([video, audio]), createStream);
  assert.equal(input.source, "browser-tab");
  assert.deepEqual(input.audioStream.getTracks(), [audio]);
  assert.equal(input.captureStream.getVideoTracks().length, 1);
  assert.equal(video.stops, 0, "video track stays alive until dispose; stopping it alone can end the share");
});

test("dispose stops every track exactly once no matter how often it is called", () => {
  const video = track("video", { displaySurface: "browser" });
  const audio = track("audio");
  const input = wrapCapture("browser-tab", stream([video, audio]), createStream);
  input.dispose();
  input.dispose();
  input.dispose();
  assert.equal(input.disposed, true);
  assert.equal(video.stops, 1);
  assert.equal(audio.stops, 1);
});

test("sharing without the audio checkbox is rejected and every track is released", () => {
  const video = track("video", { displaySurface: "browser" });
  assert.throws(() => wrapCapture("browser-tab", stream([video]), createStream),
    (error: unknown) => error instanceof LectureInputError && error.code === "no-audio");
  assert.equal(video.stops, 1);
});

test("a window or monitor share is rejected before anything reaches STT", () => {
  const video = track("video", { displaySurface: "monitor" });
  const audio = track("audio");
  assert.throws(() => wrapCapture("browser-tab", stream([video, audio]), createStream),
    (error: unknown) => error instanceof LectureInputError && error.code === "wrong-surface");
  assert.equal(video.stops, 1);
  assert.equal(audio.stops, 1);
});

test("a browser that cannot report the surface is outside v1 support", () => {
  const video = track("video", {});
  const audio = track("audio");
  assert.throws(() => wrapCapture("browser-tab", stream([video, audio]), createStream),
    (error: unknown) => error instanceof LectureInputError && error.code === "unsupported");
});

test("microphone input passes the stream through unchanged", () => {
  const audio = track("audio");
  const mic = stream([audio]);
  const input = wrapCapture("microphone", mic, createStream);
  assert.equal(input.audioStream, mic);
  input.dispose();
  assert.equal(audio.stops, 1);
});

test("closing the picker maps to 'cancelled' and never asks for the microphone", async () => {
  let micCalls = 0;
  const devices = {
    getDisplayMedia: () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
    getUserMedia: () => { micCalls += 1; return Promise.resolve(stream([])); },
  } as unknown as MediaDevices;
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
  await assert.rejects(acquireLectureInput("browser-tab", {}, { devices, createStream }),
    (error: unknown) => error instanceof LectureInputError && error.code === "cancelled");
  assert.equal(micCalls, 0);
});

test("a browser without getDisplayMedia is reported as unsupported", async () => {
  const devices = { getUserMedia: () => Promise.resolve(stream([])) } as unknown as MediaDevices;
  await assert.rejects(acquireLectureInput("browser-tab", {}, { devices, createStream }),
    (error: unknown) => error instanceof LectureInputError && error.code === "unsupported");
});

test("an inactive document returns retry guidance without falling back to microphone", async () => {
  let micCalls = 0;
  const devices = {
    getDisplayMedia: () => Promise.reject(Object.assign(new Error("Invalid state"), { name: "InvalidStateError" })),
    getUserMedia: () => { micCalls += 1; return Promise.resolve(stream([])); },
  } as unknown as MediaDevices;
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
  await assert.rejects(acquireLectureInput("browser-tab", {}, { devices, createStream }),
    (error: unknown) => error instanceof LectureInputError && error.code === "inactive");
  assert.equal(micCalls, 0);
});

test("each share gets a fresh focus controller before the picker opens synchronously", async (t) => {
  class Controller {
    behavior = "";
    setFocusBehavior(behavior: string) { this.behavior = behavior; }
  }
  stubGlobal(t, "CaptureController", Controller);
  stubGlobal(t, "MediaRecorder", { isTypeSupported: () => true });
  const controllers: Controller[] = [];
  const devices = {
    getDisplayMedia(options: DisplayMediaStreamOptions & { controller?: Controller }) {
      assert.ok(options.controller instanceof Controller);
      assert.equal(options.controller.behavior, "no-focus-change");
      controllers.push(options.controller);
      assert.deepEqual(options.video, { displaySurface: "browser" });
      assert.deepEqual(options.audio, { suppressLocalAudioPlayback: false });
      return Promise.resolve(stream([track("video", { displaySurface: "browser" }), track("audio")]));
    },
    getUserMedia() { throw new Error("Tab capture must not request a microphone"); },
  };
  const first = acquireLectureInput("browser-tab", {}, { devices, createStream });
  const second = acquireLectureInput("browser-tab", {}, { devices, createStream });
  assert.equal(controllers.length, 2, "both pickers open in the caller's synchronous turn");
  assert.notEqual(controllers[0], controllers[1], "a controller cannot be reused for another capture");
  for (const input of await Promise.all([first, second])) {
    assert.deepEqual(input.audioStream.getTracks().map((t) => t.kind), ["audio"]);
    input.dispose();
  }
});

for (const [name, Controller] of [
  ["CaptureController is absent", undefined],
  ["focus control is unsupported", class {}],
  ["controller construction throws", class {
    constructor() { throw new Error("Unavailable controller"); }
    setFocusBehavior() {}
  }],
  ["setting focus behavior throws", class {
    setFocusBehavior() { throw new TypeError("Unsupported focus behavior"); }
  }],
] as const) {
  test(`tab capture still opens synchronously when ${name}`, async (t) => {
    stubGlobal(t, "CaptureController", Controller);
    stubGlobal(t, "MediaRecorder", { isTypeSupported: () => true });
    let displayCalls = 0;
    const devices = {
      getDisplayMedia(options: DisplayMediaStreamOptions) {
        displayCalls += 1;
        assert.equal("controller" in options, false, "a failed focus hint is not passed to the browser");
        assert.deepEqual(options, {
          video: { displaySurface: "browser" },
          audio: { suppressLocalAudioPlayback: false },
          selfBrowserSurface: "exclude",
          systemAudio: "exclude",
          monitorTypeSurfaces: "exclude",
          surfaceSwitching: "exclude",
        });
        return Promise.resolve(stream([track("video", { displaySurface: "browser" }), track("audio")]));
      },
      getUserMedia() { throw new Error("Tab capture must not request a microphone"); },
    };
    const acquiring = acquireLectureInput("browser-tab", {}, { devices, createStream });
    assert.equal(displayCalls, 1);
    const input = await acquiring;
    assert.deepEqual(input.audioStream.getTracks().map((t) => t.kind), ["audio"]);
    input.dispose();
  });
}

for (const first of ["input", "consent"] as const) {
  test(`consent gate hands off live input only after both succeed (${first} first)`, async () => {
    const acquiring = deferred<LectureInput>();
    const consent = deferred<void>();
    const controller = new AbortController();
    const { input, video, audio } = consentInput();
    const waiting = waitForConsentedInput(acquiring.promise, consent.promise, controller.signal);
    let resolved = false;
    void waiting.then(() => { resolved = true; });
    if (first === "input") acquiring.resolve(input);
    else consent.resolve();
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.equal(video.stops + audio.stops, 0);
    if (first === "input") consent.resolve();
    else acquiring.resolve(input);
    assert.equal(await waiting, input);
    assert.equal(input.disposed, false);
    controller.abort();
    assert.equal(input.disposed, false, "after handoff, the caller owns cleanup");
    input.dispose();
  });
}

test("failed consent rejects while picker is pending and disposes its late input", async () => {
  const acquiring = deferred<LectureInput>();
  const consent = deferred<void>();
  const controller = new AbortController();
  const failure = new Error("Consent was not saved");
  const waiting = waitForConsentedInput(acquiring.promise, consent.promise, controller.signal);
  const rejected = assert.rejects(waiting, (error) => error === failure);
  consent.reject(failure);
  await rejected;
  const { input, video, audio } = consentInput();
  acquiring.resolve(input);
  await Promise.resolve();
  assert.equal(input.disposed, true);
  controller.abort();
  input.dispose();
  assert.equal(video.stops, 1);
  assert.equal(audio.stops, 1);
});

test("failed consent immediately disposes input acquired before the response", async () => {
  const consent = deferred<void>();
  const { input, video, audio } = consentInput();
  const failure = new Error("Consent was not saved");
  const waiting = waitForConsentedInput(Promise.resolve(input), consent.promise, new AbortController().signal);
  const rejected = assert.rejects(waiting, (error) => error === failure);
  await Promise.resolve();
  consent.reject(failure);
  await rejected;
  assert.equal(video.stops, 1);
  assert.equal(audio.stops, 1);
});

for (const first of ["input", "consent"] as const) {
  test(`both rejected promises are handled and first failure wins (${first} first)`, async () => {
    const acquiring = deferred<LectureInput>();
    const consent = deferred<void>();
    const inputFailure = new LectureInputError("cancelled");
    const consentFailure = new Error("Consent was not saved");
    const waiting = waitForConsentedInput(acquiring.promise, consent.promise, new AbortController().signal);
    const rejected = assert.rejects(waiting, (error) => error === (first === "input" ? inputFailure : consentFailure));
    if (first === "input") acquiring.reject(inputFailure);
    else consent.reject(consentFailure);
    await rejected;
    if (first === "input") consent.reject(consentFailure);
    else acquiring.reject(inputFailure);
    await Promise.resolve();
  });
}

test("picker rejection settles promptly without waiting for consent", async () => {
  const consent = deferred<void>();
  const failure = new LectureInputError("cancelled");
  await assert.rejects(waitForConsentedInput(Promise.reject(failure), consent.promise, new AbortController().signal),
    (error) => error === failure);
  consent.resolve();
});

test("the consent gate removes its abort listener after success and failure", async () => {
  for (const succeeds of [true, false]) {
    const acquiring = deferred<LectureInput>();
    const controller = new AbortController();
    const { input } = consentInput();
    const waiting = waitForConsentedInput(acquiring.promise, Promise.resolve(), controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    if (succeeds) {
      acquiring.resolve(input);
      await waiting;
    } else {
      const rejected = assert.rejects(waiting, /cancelled/);
      acquiring.reject(new LectureInputError("cancelled"));
      await rejected;
    }
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    input.dispose();
  }
});

for (const when of ["already aborted", "before input", "after input"] as const) {
  test(`aborting ${when} releases every eventual track once`, async () => {
    const acquiring = deferred<LectureInput>();
    const consent = deferred<void>();
    const controller = new AbortController();
    const reason = new DOMException("Left the lecture", "AbortError");
    const { input, video, audio } = consentInput();
    if (when === "already aborted") controller.abort(reason);
    const waiting = waitForConsentedInput(acquiring.promise, consent.promise, controller.signal);
    const rejected = assert.rejects(waiting, (error) => error === reason);
    if (when === "after input") { acquiring.resolve(input); await Promise.resolve(); }
    controller.abort(reason);
    await rejected;
    if (when !== "after input") acquiring.resolve(input);
    consent.reject(new Error("Late consent failure"));
    await Promise.resolve();
    input.dispose();
    assert.equal(video.stops, 1);
    assert.equal(audio.stops, 1);
  });
}

for (const ended of ["disposed", "audio", "video"] as const) {
  test(`an input that became ${ended} while consent was pending is not handed off`, async () => {
    const consent = deferred<void>();
    const { input, video, audio } = consentInput();
    const waiting = waitForConsentedInput(Promise.resolve(input), consent.promise, new AbortController().signal);
    const rejected = assert.rejects(waiting, (error) => error instanceof LectureInputError && error.code === "failed");
    await Promise.resolve();
    if (ended === "disposed") input.dispose();
    else Object.defineProperty(ended === "audio" ? audio : video, "readyState", { value: "ended", writable: true });
    consent.resolve();
    await rejected;
    assert.equal(input.disposed, true);
    assert.equal(video.stops, 1);
    assert.equal(audio.stops, 1);
  });
}
