import assert from "node:assert/strict";
import { test } from "node:test";

import { glossaryPrompt, parseGlossary } from "./glossary.ts";

test("splits on commas and newlines, trims, and drops repeats", () => {
  assert.deepEqual(parseGlossary(" 증권,  채권\n증권 \n"), ["증권", "채권"]);
  assert.deepEqual(parseGlossary("Fourier, fourier"), ["Fourier"]);
  assert.deepEqual(parseGlossary(undefined), []);
});

test("caps the term count and each term's length", () => {
  const many = Array.from({ length: 80 }, (_, index) => `term${index}`).join(",");
  assert.equal(parseGlossary(many).length, 60);
  assert.equal(parseGlossary("x".repeat(90))[0].length, 40);
});

test("the prompt stops at the length budget instead of cutting a term in half", () => {
  const prompt = glossaryPrompt(["가".repeat(30), "나".repeat(30), "다".repeat(30)], 65);
  assert.equal(prompt, `${"가".repeat(30)}, ${"나".repeat(30)}.`);
  assert.equal(glossaryPrompt([]), "");
});
