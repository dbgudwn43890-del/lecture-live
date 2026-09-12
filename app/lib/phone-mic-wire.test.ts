import assert from "node:assert/strict";
import test from "node:test";
import { PhonePcmReplay, decodePhoneFrame, encodePhoneFrame, PHONE_PCM_MAX_PENDING } from "./phone-mic-wire.ts";

test("PCM roundtrips intact with capture and sequence; malformed frames are rejected", () => {
  const pcm = new Int16Array([-32768, -1, 0, 32767]).buffer;
  const value = decodePhoneFrame(encodePhoneFrame(17, 42, pcm))!;
  assert.equal(value.captureId, 17); assert.equal(value.sequence, 42);
  assert.deepEqual(new Uint8Array(value.pcm), new Uint8Array(pcm));
  for (const length of [0, 8, 9, 11, 8202]) assert.equal(decodePhoneFrame(new ArrayBuffer(length)), null);
  assert.throws(() => encodePhoneFrame(0, 1, pcm));
});
test("reconnection replays only unacknowledged PCM in order without dropping samples", () => {
  const replay = new PhonePcmReplay(5);
  replay.push(new ArrayBuffer(3200)); replay.push(new ArrayBuffer(3200)); replay.push(new ArrayBuffer(3200));
  assert.equal(replay.pendingBytes, 9600);
  replay.acknowledge(0); replay.acknowledge(999); replay.acknowledge(-1);
  assert.deepEqual(replay.after(-1).map(item => item.sequence), [1, 2]);
  assert.equal(replay.pendingBytes, 6400);
  replay.acknowledge(2); assert.equal(replay.pendingBytes, 0);
});
test("bounded replay fails explicitly before silently dropping or overwriting audio", () => {
  const replay = new PhonePcmReplay(9);
  replay.push(new ArrayBuffer(PHONE_PCM_MAX_PENDING));
  assert.throws(() => replay.push(new ArrayBuffer(2)), /BUFFER_FULL/);
  assert.equal(replay.pendingBytes, PHONE_PCM_MAX_PENDING);
  const frames = replay.after(-1).map(item => decodePhoneFrame(item.frame)!);
  assert.ok(frames.every(frame => frame.captureId === 9 && frame.pcm.byteLength <= 8192));
  assert.equal(frames.reduce((n, frame) => n + frame.pcm.byteLength, 0), PHONE_PCM_MAX_PENDING);
  replay.clear(); assert.equal(replay.pendingBytes, 0);
});
