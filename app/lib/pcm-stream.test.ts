import assert from "node:assert/strict";
import test from "node:test";
import { PcmStreamEncoder } from "./pcm-stream.ts";

test("raw 16kHz mono has exactly 32,000 bytes per second", () => {
  assert.equal(new PcmStreamEncoder(16000).encode(new Float32Array(16000)).byteLength, 32000);
});
test("44.1kHz streaming has no rounding drift across 4096-frame worklet blocks", () => {
  const input = new Float32Array(44100 * 10).fill(0.5);
  const streaming = new PcmStreamEncoder(44100);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < input.length; offset += 4096) chunks.push(new Uint8Array(streaming.encode(input.subarray(offset, offset + 4096))));
  const actual = Buffer.concat(chunks);
  assert.equal(actual.byteLength, 320000);
  assert.deepEqual(actual, Buffer.from(new PcmStreamEncoder(44100).encode(input)));
});
test("PCM clamps input and encodes signed little endian samples", () => {
  const view = new DataView(new PcmStreamEncoder(16000).encode(new Float32Array([-2, 0, 2, NaN])));
  assert.deepEqual([0, 2, 4, 6].map(offset => view.getInt16(offset, true)), [-32768, 0, 32767, 0]);
});
