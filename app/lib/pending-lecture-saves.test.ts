import assert from "node:assert/strict";
import test from "node:test";
import { PendingLectureSaves } from "./pending-lecture-saves.ts";

test("a failed lecture retries its own snapshot after switching lectures", async () => {
  const queue = new PendingLectureSaves();
  const segments = [{ id: "a", startMs: 0, endMs: 1000, text: "first lecture" }];
  queue.add({ sessionId: "first", durationMs: 1000, segments });
  assert.equal(await queue.save("first", async () => false), false);
  segments[0].text = "another lecture";
  queue.add({ sessionId: "second", durationMs: 2000, segments });
  await queue.save("first", async value => {
    assert.equal(value.segments[0].text, "first lecture");
    return true;
  });
  assert.deepEqual(queue.ids(), ["second"]);
});

test("concurrent retry cannot send twice or clear another lecture", async () => {
  const queue = new PendingLectureSaves();
  queue.add({ sessionId: "a", durationMs: 1, segments: [] });
  queue.add({ sessionId: "b", durationMs: 2, segments: [] });
  let finish!: (saved: boolean) => void;
  const first = queue.save("a", () => new Promise(resolve => { finish = resolve; }));
  assert.equal(await queue.save("a", async () => { assert.fail("duplicate request"); }), false);
  finish(true);
  await first;
  assert.deepEqual(queue.ids(), ["b"]);
  await queue.save("b", async () => false);
  assert.deepEqual(queue.ids(), ["b"]);
  await queue.save("b", async () => true);
  assert.deepEqual(queue.ids(), []);
});
