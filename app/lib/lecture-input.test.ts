import assert from "node:assert/strict";
import test from "node:test";

import { LectureInputError, acquireLectureInput, wrapCapture } from "./lecture-input.ts";

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
