import assert from "node:assert/strict";
import test from "node:test";

import { callbackToken, callbackTokenMatches, segmentsFromPrerecorded } from "./lecture-audio.ts";

test("utterances become one segment each, in lecture-clock milliseconds", () => {
  const segments = segmentsFromPrerecorded({
    results: {
      utterances: [
        { start: 0, end: 2.5, transcript: "증권은 재산상의 권리입니다." },
        { start: 2.5, end: 6.25, transcript: "주식은 회사의 일부입니다." },
      ],
    },
  });

  assert.equal(segments.length, 2);
  assert.deepEqual(
    segments.map((segment) => [segment.startMs, segment.endMs, segment.text]),
    [[0, 2500, "증권은 재산상의 권리입니다."], [2500, 6250, "주식은 회사의 일부입니다."]],
  );
});

test("an utterance with no transcript is dropped rather than stored empty", () => {
  const segments = segmentsFromPrerecorded({
    results: { utterances: [{ start: 0, end: 1, transcript: "   " }, { start: 1, end: 2, transcript: "실제 내용" }] },
  });
  assert.deepEqual(segments.map((segment) => segment.text), ["실제 내용"]);
});

test("two identical utterances in the same window collapse to one row", () => {
  // transcript_segments is unique on (session_id, client_id); a duplicate would
  // be silently swallowed by the upsert and make the saved count a lie.
  const segments = segmentsFromPrerecorded({
    results: {
      utterances: [
        { start: 1, end: 2, transcript: "네." },
        { start: 1, end: 2, transcript: "네." },
      ],
    },
  });
  assert.equal(segments.length, 1);
});

test("a response without utterances falls back to slicing the word list", () => {
  // 200 words a second apart: far past the 45s ceiling, so this must not come
  // back as one unusable paragraph.
  const words = Array.from({ length: 200 }, (_, index) => ({
    start: index,
    end: index + 1,
    word: `말${index}`,
    punctuated_word: `말${index}`,
  }));
  const segments = segmentsFromPrerecorded({ results: { channels: [{ alternatives: [{ words }] }] } });

  assert.ok(segments.length > 1, "expected the word list to be split");
  for (const segment of segments) {
    assert.ok(segment.endMs - segment.startMs <= 46_000, "a segment ran past the 45s ceiling");
    assert.ok(segment.text.length <= 2_000);
    assert.ok(segment.endMs >= segment.startMs);
  }
  assert.ok(segments.at(-1)!.text.includes("말199"), "the tail of the lecture was dropped");
});

test("a callback token only matches the upload it was minted for", () => {
  // Both helpers read the secret at call time, so setting it here is enough.
  process.env.LECTURE_AUDIO_CALLBACK_SECRET = "test-secret";
  const token = callbackToken("11111111-1111-4111-8111-111111111111");

  assert.ok(callbackTokenMatches("11111111-1111-4111-8111-111111111111", token));
  assert.equal(callbackTokenMatches("22222222-2222-4222-8222-222222222222", token), false);
  assert.equal(callbackTokenMatches("11111111-1111-4111-8111-111111111111", "not-a-token"), false);
});
