import assert from "node:assert/strict";
import test from "node:test";

import { downsampleAudio, encodeWav, STT_SAMPLE_RATE } from "./audio.ts";

test("downsamples 48 kHz PCM to 16 kHz", () => {
  const input = new Float32Array(48_000).fill(0.25);
  const output = downsampleAudio(input, 48_000);

  assert.equal(output.length, STT_SAMPLE_RATE);
  assert.ok(output.every((sample) => Math.abs(sample - 0.25) < 0.0001));
});

test("encodes mono 16-bit PCM as a valid WAV file", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1]));
  const bytes = new Uint8Array(wav);
  const view = new DataView(wav);

  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WAVE");
  assert.equal(view.getUint32(24, true), STT_SAMPLE_RATE);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getInt16(46, true), 0x7fff);
  assert.equal(view.getInt16(48, true), -0x8000);
});
