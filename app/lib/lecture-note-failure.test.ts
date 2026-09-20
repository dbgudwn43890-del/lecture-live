import assert from "node:assert/strict";
import test from "node:test";
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";
import { classifyNoteFailure, type NoteFailureStage } from "./lecture-note-failure.ts";
import { validateLectureNote, type NoteEvidence } from "./lecture-note-context.ts";

test("classifies a real validator failure without copying its message", () => {
  const evidence: NoteEvidence = { sources: new Map(), questions: new Set(), questionSources: new Map(), documents: [] };
  let failure: unknown;
  try { validateLectureNote({ sections: [] }, evidence); } catch (error) { failure = error; }
  assert.deepEqual(classifyNoteFailure(failure, "validate"), { category: "validation", reason: "empty_note" });
  assert.deepEqual(classifyNoteFailure(new Error("invalid note formula"), "validate"), { category: "validation", reason: "invalid_formula" });
  assert.deepEqual(classifyNoteFailure(new Error("material does not match evidence"), "validate"), { category: "validation", reason: "material_evidence_mismatch" });
});

test("recognizes actual SDK timeout and connection classes despite their Error name", () => {
  const timeout = new APIConnectionTimeoutError({ message: "private provider response" });
  assert.equal(timeout.name, "Error");
  assert.deepEqual(classifyNoteFailure(timeout, "generate"), { category: "timeout", reason: "request_timeout" });
  assert.deepEqual(classifyNoteFailure(new APIConnectionError({ message: "private connection detail" }), "generate"), { category: "provider", reason: "connection_failed" });
  assert.deepEqual(classifyNoteFailure(new Error("note preparation exceeded time budget"), "prepare"), { category: "timeout", reason: "time_budget_exceeded" });
});

test("distinguishes abort from timeout and bounds recognized error names", () => {
  for (const error of [new APIUserAbortError(), new DOMException("private", "AbortError")]) {
    assert.deepEqual(classifyNoteFailure(error, "generate"), { category: "cancelled", reason: "request_aborted" });
  }
  assert.deepEqual(classifyNoteFailure(new DOMException("private", "TimeoutError"), "generate"), { category: "timeout", reason: "request_timeout" });
  assert.deepEqual(classifyNoteFailure({ name: "private unknown class" }, "generate"), { category: "provider", reason: "provider_unknown" });
});

test("logs only an allowed numeric HTTP status and fixed response disposition", () => {
  assert.deepEqual(classifyNoteFailure({ status: 429, message: "private rate limit details" }, "generate"), { category: "provider", reason: "http_error", httpStatus: 429 });
  for (const status of ["429", 418, NaN, Infinity, 200]) {
    assert.deepEqual(classifyNoteFailure({ status }, "generate"), { category: "provider", reason: "provider_unknown" });
  }
  for (const status of ["incomplete", "failed", "cancelled"]) {
    assert.deepEqual(classifyNoteFailure(new Error("private"), "generate", status), {
      category: status === "cancelled" ? "cancelled" : "provider", reason: `response_${status}`,
    });
  }
});

test("keeps parse, validation, preparation and persistence failures distinct", () => {
  assert.deepEqual(classifyNoteFailure(new SyntaxError("private JSON source"), "parse"), { category: "parse", reason: "invalid_json" });
  assert.deepEqual(classifyNoteFailure(new Error("private"), "parse"), { category: "parse", reason: "parse_unknown" });
  assert.deepEqual(classifyNoteFailure({ code: "private database detail", status: 503 }, "save"), { category: "save", reason: "save_failed" });
  assert.deepEqual(classifyNoteFailure(new Error("private"), "prepare"), { category: "prepare", reason: "prepare_failed" });
  for (const message of ["constructor", "__proto__", "unsupported diagram: private content"]) {
    assert.deepEqual(classifyNoteFailure(new Error(message), "validate"), { category: "validation", reason: "validation_unknown" });
  }
});

test("never returns provider text, prompts, credentials, bodies or nested causes", () => {
  const secret = "SYNTHETIC_PRIVATE_SENTINEL";
  const error = { name: secret, message: secret, status: secret, stack: secret, body: { prompt: secret }, apiKey: secret, cause: new Error(secret) };
  for (const stage of ["prepare", "generate", "parse", "validate", "save"] as NoteFailureStage[]) {
    const result = classifyNoteFailure(error, stage, secret);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_SENTINEL/);
    assert.deepEqual(Object.keys(result).sort(), ["category", "reason"]);
  }
  for (const value of [null, undefined, secret, 7]) assert.doesNotThrow(() => classifyNoteFailure(value, "generate"));
});
