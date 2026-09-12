import assert from "node:assert/strict";
import test from "node:test";

import { isSpeechLanguage, SPEECH_LANGUAGES } from "./speech-languages.ts";

test("the product supports the verified Nova-3 languages and Korean-English mode", () => {
  const codes = ["en", "ko", "multi", "es", "ja", "zh", "fr", "de", "pt", "hi"];
  assert.deepEqual(SPEECH_LANGUAGES.map(({ code }) => code), codes);
  for (const code of codes) assert.equal(isSpeechLanguage(code), true);
});

test("the product validator rejects lab mode, unlisted dialects, and malformed input", () => {
  for (const value of ["default", "en-US", "unknown", "EN", "", " en ", null, undefined, {}, 1]) {
    assert.equal(isSpeechLanguage(value), false);
  }
});
