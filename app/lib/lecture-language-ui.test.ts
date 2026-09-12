import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch { return next(`${specifier}.ts`, context); } } });
const { initialSpeechLanguage, lectureLanguageChoices } = await import("./lecture-language-ui.ts");

test("region changes prominence and first-visit defaults, not a saved choice", () => {
  assert.equal(initialSpeechLanguage(null, "global"), "en");
  assert.equal(initialSpeechLanguage(null, "kr"), "multi");
  for (const language of ["ko", "multi", "en", "es", "ja", "zh", "fr", "de", "pt", "hi"]) {
    assert.equal(initialSpeechLanguage(language, "global"), language);
    assert.equal(initialSpeechLanguage(language, "kr"), language);
  }
  assert.equal(initialSpeechLanguage("unsupported", "global"), "en");
});

test("foreign visitors see English first and Korean among other languages", () => {
  const global = lectureLanguageChoices("global", "en");
  assert.deepEqual(global.primary.map(x => x.id), ["en"]);
  assert(global.other.some(x => x.id === "ko" && x.label === "한국어"));
  const korean = lectureLanguageChoices("kr", "en");
  assert.deepEqual(korean.primary.map(x => x.id), ["ko", "multi", "en"]);
  assert.deepEqual(korean.other.map(x => x.id), ["es", "ja", "zh", "fr", "de", "pt", "hi"]);
});
