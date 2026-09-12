import assert from "node:assert/strict";
import test from "node:test";
import { listeningState } from "./listening-state.ts";

test("listening animates only during recording with audio available", () => {
  for (const status of ["idle", "connecting", "paused", "ended", "error"]) {
    assert.equal(listeningState(status, false, false, false).live, false);
  }
  assert.deepEqual(listeningState("recording", false, false, false), { live: true, text: "소리를 함께 듣고 있어요" });
  assert.equal(listeningState("recording", true, false, false).live, false);
  assert.equal(listeningState("recording", false, true, false).live, false);
});
test("waiting, pause and English labels explain actual state", () => {
  assert.match(listeningState("recording", true, false, false).text, /기다리고/);
  assert.match(listeningState("paused", false, false, false).text, /멈췄/);
  assert.equal(listeningState("recording", false, false, true).text, "Listening along with you");
});
