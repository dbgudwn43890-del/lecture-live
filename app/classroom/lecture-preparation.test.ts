import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { audioUploadKey, createTitleSaveQueue, hasReadyMaterials, preparationTitle } from "./lecture-preparation.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("preparation keeps the entered lecture title when material upload creates the session", () => {
  const title = "UX 점검용 · 가중평균 · 2026-09-11";
  for (const english of [false, true]) {
    assert.equal(preparationTitle(`  ${title}  `, english, new Date(2026, 8, 12)), title);
  }
});

test("only an empty preparation title falls back to the localized lecture date", () => {
  const now = new Date(2026, 8, 11, 12);
  assert.equal(preparationTitle(" \n\t ", false, now), "2026. 9. 11. 수업");
  assert.equal(preparationTitle("", true, now), "Lecture 9/11/2026");
  assert.equal(preparationTitle("0", false, now), "0");
});

test("only a material with readable pages in the active session unlocks questions", () => {
  assert.equal(hasReadyMaterials("", [{ session_id: "", page_count: 1 }]), false);
  assert.equal(hasReadyMaterials("current", []), false);
  assert.equal(hasReadyMaterials("current", [{ session_id: "previous", page_count: 10 }]), false);
  for (const pageCount of [0, -1, Number.NaN]) {
    assert.equal(hasReadyMaterials("current", [{ session_id: "current", page_count: pageCount }]), false);
  }
  const materials = [{ session_id: "previous", page_count: 10 }, { session_id: "current", page_count: 0 }];
  assert.equal(hasReadyMaterials("current", materials), false);
  materials.push({ session_id: "current", page_count: 1 });
  assert.equal(hasReadyMaterials("current", materials), true);
  assert.equal(hasReadyMaterials("next", materials), false, "switching lectures must not retain the previous readiness");
});

test("a slow older rename finishes before newer titles are written to the same lecture", async () => {
  const queue = createTitleSaveQueue();
  const olderResponse = deferred();
  const started: string[] = [];
  const stored: string[] = [];
  const first = queue("lecture", "First title", async () => {
    started.push("First title");
    await olderResponse.promise;
    stored.push("First title");
  });
  const second = queue("lecture", "Second title", async () => { started.push("Second title"); stored.push("Second title"); });
  const latest = queue("lecture", "Final title", async () => { started.push("Final title"); stored.push("Final title"); });
  await setImmediate();
  assert.deepEqual(started, ["First title"]);
  assert.deepEqual(stored, []);
  olderResponse.resolve();
  await Promise.all([first, second, latest]);
  assert.deepEqual(stored, ["First title", "Second title", "Final title"]);
  assert.equal(stored.at(-1), "Final title");
});

test("duplicate in-flight title saves share the same request and release after completion", async () => {
  const queue = createTitleSaveQueue();
  const response = deferred();
  let writes = 0;
  const save = async () => { writes++; await response.promise; };
  const first = queue("lecture", "Same title", save);
  const duplicate = queue("lecture", "Same title", save);
  assert.equal(duplicate, first);
  await setImmediate();
  assert.equal(writes, 1);
  response.resolve();
  await Promise.all([first, duplicate]);
  await queue("lecture", "Same title", async () => { writes++; });
  assert.equal(writes, 2, "completed entries must not suppress a later explicit save");
});

test("an unresolved save for another lecture does not block the active lecture", async () => {
  const queue = createTitleSaveQueue();
  const oldLecture = deferred();
  const writes: string[] = [];
  const oldSave = queue("previous", "Title", async () => { await oldLecture.promise; writes.push("previous"); });
  await queue("current", "Title", async () => { writes.push("current"); });
  assert.deepEqual(writes, ["current"]);
  oldLecture.resolve();
  await oldSave;
  assert.deepEqual(writes, ["current", "previous"]);
});

test("a failed rename rejects its caller while queued and future saves can still succeed", async () => {
  const queue = createTitleSaveQueue();
  const failedResponse = deferred();
  const first = queue("lecture", "First", () => failedResponse.promise);
  const failure = assert.rejects(first, /save failed/);
  const saved: string[] = [];
  const newer = queue("lecture", "Newer", async () => { saved.push("Newer"); });
  failedResponse.reject(new Error("save failed"));
  await Promise.all([failure, newer]);
  await queue("lecture", "Future", async () => { saved.push("Future"); });
  assert.deepEqual(saved, ["Newer", "Future"]);
});

test("long Unicode audio names produce a bounded stable SHA-256 retry key", async () => {
  const file = { name: `${"매우 긴 강의 이름 🎙️ · ".repeat(100)}2026-09-11.wav`, size: 1_024_000, lastModified: 1_789_120_000_000 };
  const key = await audioUploadKey(file);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, createHash("sha256").update(JSON.stringify([file.name, file.size, file.lastModified])).digest("hex"));
  assert.equal(await audioUploadKey({ ...file }), key);
  const variants = [
    { ...file, name: `${file.name}.m4a` },
    { ...file, size: file.size + 1 },
    { ...file, lastModified: file.lastModified + 1 },
  ];
  const keys = await Promise.all(variants.map(audioUploadKey));
  assert.equal(new Set([key, ...keys]).size, 4, "each file metadata change needs an independent retry identity");
});
