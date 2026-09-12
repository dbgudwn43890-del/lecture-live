import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createLectureNoteController } from "./lecture-note-state.ts";

const oldNote = { title: "Previous note", summary: "Previous summary", sections: [] };
const newNote = { title: "New note", summary: "New summary", sections: [] };
const startedAt = "2026-09-07T06:00:00.000Z";
const previousTime = "2026-09-06T06:00:00.000Z";
const doneTime = "2026-09-07T06:01:00.000Z";
const json = (body: unknown, status = 200) => Response.json(body, { status });
const waiting = (content: unknown = null, time: string | null = startedAt) => ({ note: { status: "generating", content, updated_at: time } });
const ready = (content = oldNote, time = previousTime) => ({ note: { status: "ready", content, updated_at: time } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const [english, language] of [[false, "ja"], [true, "ko"]] as const) {
  test(`generation sends ${language} output separately from the ${english ? "English" : "Korean"} UI locale`, async t => {
    const requests: RequestInit[] = [];
    let submitted = false;
    const controller = createLectureNoteController("lecture-a", english, async (_url, init) => {
      requests.push(init!);
      if (init?.method === "POST") {
        submitted = true;
        return json(waiting(), 202);
      }
      return json(submitted ? waiting() : { note: null });
    });
    t.after(() => controller.dispose());
    controller.start();
    await setImmediate();
    await controller.generate(false, language);
    await setImmediate();
    const posts = requests.filter(request => request.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(String(posts[0].body)), { sessionId: "lecture-a", force: false, language });
    assert.equal(posts[0].keepalive, true);
    for (const request of requests) {
      assert.equal(new Headers(request.headers).get("x-site-locale"), english ? "en" : "ko");
    }
    assert.equal(controller.getSnapshot().phase, "generating");
    assert.equal(controller.getSnapshot().startedAt, startedAt);
  });
}

test("legacy generation omits the optional output language instead of sending a system preference", async t => {
  let payload: unknown;
  const controller = createLectureNoteController("lecture-a", true, async (_url, init) => {
    if (init?.method === "POST") {
      payload = JSON.parse(String(init.body));
      return json(ready(newNote, doneTime));
    }
    return json({ note: null });
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  await controller.generate(false);
  assert.deepEqual(payload, { sessionId: "lecture-a", force: false });
  assert.equal(controller.getSnapshot().phase, "ready");
});

test("regeneration uses the new concrete selection while preserving the previous note until completion", async t => {
  const previous = { ...oldNote, language: "en" as const };
  const replacement = { ...newNote, language: "es" as const };
  let submitted = false;
  let finished = false;
  let request: RequestInit | undefined;
  const controller = createLectureNoteController("lecture-a", true, async (_url, init) => {
    if (init?.method === "POST") {
      request = init;
      submitted = true;
      return json(waiting(previous), 202);
    }
    return json(finished ? ready(replacement, doneTime) : submitted ? waiting(previous) : ready(previous));
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  await controller.generate(true, "es");
  await setImmediate();
  assert.deepEqual(JSON.parse(String(request?.body)), { sessionId: "lecture-a", force: true, language: "es" });
  assert.equal(new Headers(request?.headers).get("x-site-locale"), "en");
  assert.equal(controller.getSnapshot().phase, "generating");
  assert.deepEqual(controller.getSnapshot().note, previous);
  finished = true;
  await controller.reload();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.deepEqual(controller.getSnapshot().note, replacement);
});

test("another language request cannot replace a pending or acknowledged generation or reset its start time", async t => {
  const submission = deferred<Response>();
  const previous = { ...oldNote, language: "ko" as const };
  const replacement = { ...newNote, language: "ja" as const };
  const payloads: unknown[] = [];
  let accepted = false;
  let finished = false;
  const controller = createLectureNoteController("lecture-a", false, async (_url, init) => {
    if (init?.method === "POST") {
      payloads.push(JSON.parse(String(init.body)));
      return submission.promise;
    }
    return json(finished ? ready(replacement, doneTime) : accepted ? waiting(previous) : ready(previous));
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  const first = controller.generate(true, "ja");
  const pending = controller.getSnapshot();
  await controller.generate(true, "fr");
  assert.equal(controller.getSnapshot(), pending, "a second selection must not publish a replacement pending state");
  assert.equal(payloads.length, 1);

  accepted = true;
  submission.resolve(json(waiting(previous), 202));
  await first;
  await setImmediate();
  const active = controller.getSnapshot();
  assert.equal(active.phase, "generating");
  assert.equal(active.startedAt, startedAt);
  await controller.generate(false, "de");
  assert.equal(controller.getSnapshot(), active, "a later selection must preserve the accepted generation and timestamp");
  assert.deepEqual(payloads, [{ sessionId: "lecture-a", force: true, language: "ja" }]);
  assert.deepEqual(controller.getSnapshot().note, previous);
  finished = true;
  await controller.reload();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.deepEqual(controller.getSnapshot().note, replacement);
});

test("restoring a session uses the server start time rather than the time the dialog reopened", async t => {
  const fetcher: typeof fetch = async () => json(waiting());
  const first = createLectureNoteController("lecture-a", false, fetcher);
  first.start();
  await setImmediate();
  assert.equal(first.getSnapshot().phase, "generating");
  assert.equal(first.getSnapshot().startedAt, startedAt);
  first.dispose();
  const reopened = createLectureNoteController("lecture-a", false, fetcher);
  t.after(() => reopened.dispose());
  reopened.start();
  await setImmediate();
  assert.equal(reopened.getSnapshot().startedAt, first.getSnapshot().startedAt);
});

test("polling continues after the dialog's subscriber leaves and stops once the note is ready", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finished = false;
  let reads = 0;
  const controller = createLectureNoteController("lecture-a", false, async () => {
    reads += 1;
    return json(finished ? ready(newNote, doneTime) : waiting());
  });
  t.after(() => controller.dispose());
  const unsubscribe = controller.subscribe(() => {});
  controller.start();
  await setImmediate();
  unsubscribe();
  finished = true;
  t.mock.timers.tick(3_000);
  await setImmediate();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.deepEqual(controller.getSnapshot().note, newNote);
  assert.equal(controller.getSnapshot().startedAt, null);
  t.mock.timers.tick(9_000);
  await setImmediate();
  assert.equal(reads, 2);
});

test("a duplicate response without a timestamp never resets a known server start time", async t => {
  let submitted = false;
  const controller = createLectureNoteController("lecture-a", false, async (_url, init) => {
    if (init?.method === "POST") {
      submitted = true;
      return json({ ...waiting(null), remainingGenerations: 4 }, 202);
    }
    return json(submitted ? waiting(null, null) : { note: null, remainingGenerations: 5 });
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  await controller.generate(false);
  await setImmediate();
  assert.equal(controller.getSnapshot().startedAt, startedAt);
  assert.equal(controller.getSnapshot().remaining, 4);
  await controller.reload();
  assert.equal(controller.getSnapshot().startedAt, startedAt);
});

test("a GET started before generation cannot replace the job state with the old ready note", async t => {
  const staleRead = deferred<Response>();
  let reads = 0;
  let staleSignal: AbortSignal | null | undefined;
  const controller = createLectureNoteController("lecture-a", false, async (_url, init) => {
    if (init?.method === "POST") return json(waiting(oldNote), 202);
    reads += 1;
    if (reads === 1) return json(ready());
    if (reads === 2) { staleSignal = init?.signal; return staleRead.promise; }
    return json(waiting(oldNote));
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  const pendingRead = controller.reload();
  await controller.generate(true);
  await setImmediate();
  assert.equal(staleSignal?.aborted, true);
  staleRead.resolve(json(ready()));
  await pendingRead;
  assert.equal(controller.getSnapshot().phase, "generating");
  assert.equal(controller.getSnapshot().startedAt, startedAt);
});

test("a duplicate 202 during preparation does not mistake the unchanged previous note for completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let preparing = true;
  let posts = 0;
  const controller = createLectureNoteController("lecture-a", false, async (_url, init) => {
    if (init?.method === "POST") { posts += 1; return json(waiting(oldNote, null), 202); }
    return json(preparing ? ready() : waiting(oldNote));
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  await controller.generate(true);
  await setImmediate();
  assert.equal(controller.getSnapshot().phase, "generating");
  assert.equal(controller.getSnapshot().startedAt, null);
  assert.match(controller.getSnapshot().message, /준비/);
  preparing = false;
  t.mock.timers.tick(3_000);
  await setImmediate();
  assert.equal(controller.getSnapshot().phase, "generating");
  assert.equal(controller.getSnapshot().startedAt, startedAt);
  assert.equal(controller.getSnapshot().message, "");
  assert.equal(posts, 1);
});

test("leaving a session does not abort its POST or leak its response into the new session", async t => {
  const post = deferred<Response>();
  let postSignal: AbortSignal | null | undefined;
  let postKeepalive: boolean | undefined;
  let oldReads = 0;
  const old = createLectureNoteController("lecture-a", false, async (_url, init) => {
    if (init?.method === "POST") { postSignal = init.signal; postKeepalive = init.keepalive; return post.promise; }
    oldReads += 1;
    return json(ready());
  });
  old.start();
  await setImmediate();
  const submission = old.generate(true);
  old.dispose();
  const next = createLectureNoteController("lecture-b", true, async () => json(ready(newNote)));
  t.after(() => next.dispose());
  next.start();
  await setImmediate();
  post.resolve(json(waiting(oldNote), 202));
  await submission;
  await setImmediate();
  assert.equal(postSignal, undefined);
  assert.equal(postKeepalive, true);
  assert.equal(oldReads, 1);
  assert.equal(next.getSnapshot().phase, "ready");
  assert.deepEqual(next.getSnapshot().note, newNote);
});

test("a temporary polling failure keeps the job and elapsed time, then recovers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const controller = createLectureNoteController("lecture-a", false, async () => {
    reads += 1;
    if (reads === 1) return json(waiting());
    if (reads === 2) return json({ error: "잠시 연결할 수 없습니다." }, 503);
    return json(ready(newNote, doneTime));
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  t.mock.timers.tick(3_000);
  await setImmediate();
  assert.equal(controller.getSnapshot().phase, "generating");
  assert.equal(controller.getSnapshot().startedAt, startedAt);
  assert.match(controller.getSnapshot().message, /연결/);
  t.mock.timers.tick(3_000);
  await setImmediate();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().message, "");
});

test("a failed regeneration preserves the previous note and uses the server quota", async t => {
  const controller = createLectureNoteController("lecture-a", true, async (_url, init) => init?.method === "POST"
    ? json({ note: { status: "failed", content: oldNote }, error: "Daily limit reached.", remainingGenerations: 0 }, 429)
    : json(ready()));
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  await controller.generate(true);
  assert.equal(controller.getSnapshot().phase, "failed");
  assert.deepEqual(controller.getSnapshot().note, oldNote);
  assert.equal(controller.getSnapshot().remaining, 0);
  assert.equal(controller.getSnapshot().message, "Daily limit reached.");
});

test("a lost POST response checks the server without resubmitting or accepting an unchanged old note as completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let posts = 0;
  let submitted = false;
  let jobVisible = false;
  const controller = createLectureNoteController("lecture-a", false, async (_url, init) => {
    if (init?.method === "POST") { posts += 1; submitted = true; throw new TypeError("Failed to fetch"); }
    return json(submitted && jobVisible ? waiting(oldNote) : ready());
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  await controller.generate(true);
  await setImmediate();
  assert.equal(controller.getSnapshot().phase, "generating");
  assert.equal(controller.getSnapshot().startedAt, null);
  assert.match(controller.getSnapshot().message, /확인하고/);
  await controller.generate(true);
  assert.equal(posts, 1);
  jobVisible = true;
  t.mock.timers.tick(3_000);
  await setImmediate();
  assert.equal(controller.getSnapshot().startedAt, startedAt);
  assert.equal(controller.getSnapshot().message, "");
  assert.equal(posts, 1);
});

test("an unconfirmed request eventually asks for a status reload and never charges for an automatic retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse(startedAt) });
  let posts = 0;
  const controller = createLectureNoteController("lecture-a", false, async (_url, init) => {
    if (init?.method === "POST") { posts += 1; throw new TypeError("Failed to fetch"); }
    return json({ note: null });
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  await controller.generate(false);
  await setImmediate();
  t.mock.timers.tick(30_000);
  await setImmediate();
  assert.equal(controller.getSnapshot().phase, "error");
  assert.match(controller.getSnapshot().message, /다시 불러와/);
  assert.equal(posts, 1);
});

for (const responseKind of ["lost response", "duplicate 202"] as const) {
  test(`retrying a failed note survives its unchanged failed row after a ${responseKind}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let current = { note: { status: "failed", content: oldNote, updated_at: previousTime } };
    let posts = 0;
    const controller = createLectureNoteController("lecture-a", false, async (_url, init) => {
      if (init?.method === "POST") {
        posts += 1;
        if (responseKind === "lost response") throw new TypeError("Failed to fetch");
        return json(waiting(oldNote, null), 202);
      }
      return json(current);
    });
    t.after(() => controller.dispose());
    controller.start();
    await setImmediate();
    assert.equal(controller.getSnapshot().phase, "failed");
    await controller.generate(true);
    await setImmediate();
    assert.equal(controller.getSnapshot().phase, "generating");
    assert.equal(controller.getSnapshot().startedAt, null);
    assert.deepEqual(controller.getSnapshot().note, oldNote);
    current = { note: { status: "generating", content: oldNote, updated_at: startedAt } };
    t.mock.timers.tick(3_000);
    await setImmediate();
    assert.equal(controller.getSnapshot().phase, "generating");
    assert.equal(controller.getSnapshot().startedAt, startedAt);
    current = ready(newNote, doneTime);
    t.mock.timers.tick(3_000);
    await setImmediate();
    assert.equal(controller.getSnapshot().phase, "ready");
    assert.deepEqual(controller.getSnapshot().note, newNote);
    assert.equal(posts, 1);
  });
}

test("an unchanged failed row keeps confirmation until expiry, then requests a status reload", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse(startedAt) });
  let posts = 0;
  const controller = createLectureNoteController("lecture-a", false, async (_url, init) => {
    if (init?.method === "POST") { posts += 1; throw new TypeError("Failed to fetch"); }
    return json({ note: { status: "failed", content: oldNote, updated_at: previousTime } });
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  await controller.generate(true);
  await setImmediate();
  t.mock.timers.tick(29_000);
  await setImmediate();
  assert.equal(controller.getSnapshot().phase, "generating");
  t.mock.timers.tick(3_000);
  await setImmediate();
  assert.equal(controller.getSnapshot().phase, "error");
  assert.match(controller.getSnapshot().message, /다시 불러와/);
  assert.deepEqual(controller.getSnapshot().note, oldNote);
  assert.equal(posts, 1);
});

test("an earlier GET cannot overwrite a restarted controller, even when abort is ignored", async t => {
  const stale = deferred<Response>();
  let reads = 0;
  const controller = createLectureNoteController("lecture-a", false, async () => {
    reads += 1;
    return reads === 1 ? stale.promise : json(ready(newNote, doneTime));
  });
  t.after(() => controller.dispose());
  controller.start();
  controller.dispose();
  controller.start();
  await controller.reload();
  stale.resolve(json(ready()));
  await setImmediate();
  assert.deepEqual(controller.getSnapshot().note, newNote);
});

test("focus, visibility and polling share an in-flight note read and await the same result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = deferred<Response>();
  let reads = 0;
  let signal: AbortSignal | null | undefined;
  const controller = createLectureNoteController("lecture-a", false, async (_url, init) => {
    reads++;
    if (reads === 1) return json(waiting());
    signal = init?.signal;
    return result.promise;
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  const focused = controller.reload();
  const visible = controller.reload();
  assert.equal(focused, visible);
  t.mock.timers.tick(3_000);
  await setImmediate();
  assert.equal(reads, 2, "the initial read plus one shared refresh");
  assert.equal(signal?.aborted, false);
  result.resolve(json(ready(newNote, doneTime)));
  await Promise.all([focused, visible]);
  assert.deepEqual(controller.getSnapshot().note, newNote);
  t.mock.timers.tick(9_000);
  await setImmediate();
  assert.equal(reads, 2, "ready notes stop polling");
});

test("a failed shared read releases the slot for the next explicit retry", async t => {
  const failed = deferred<Response>();
  let reads = 0;
  const controller = createLectureNoteController("lecture-a", true, async () => {
    reads++;
    return reads === 1 ? failed.promise : json(ready(newNote, doneTime));
  });
  t.after(() => controller.dispose());
  controller.start();
  const first = controller.reload();
  assert.equal(first, controller.reload());
  failed.resolve(json({ error: "Could not load the note." }, 503));
  await first;
  assert.equal(controller.getSnapshot().phase, "error");
  await controller.reload();
  assert.equal(reads, 2);
  assert.deepEqual(controller.getSnapshot().note, newNote);
});

test("generation replaces a shared read and its late result cannot release the newer read", async t => {
  const stale = deferred<Response>();
  const fresh = deferred<Response>();
  let reads = 0;
  let staleSignal: AbortSignal | null | undefined;
  const controller = createLectureNoteController("lecture-a", false, async (_url, init) => {
    if (init?.method === "POST") return json(waiting(oldNote), 202);
    reads++;
    if (reads === 1) return json(ready());
    if (reads === 2) { staleSignal = init?.signal; return stale.promise; }
    return fresh.promise;
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  const oldRead = controller.reload();
  assert.equal(oldRead, controller.reload());
  await controller.generate(true);
  assert.equal(staleSignal?.aborted, true);
  assert.equal(reads, 3, "generation starts its own read instead of joining the aborted one");
  const currentRead = controller.reload();
  stale.resolve(json(ready()));
  await oldRead;
  assert.equal(controller.getSnapshot().phase, "generating");
  assert.equal(controller.getSnapshot().message, "", "generation cancellation is not a load failure");
  assert.equal(controller.reload(), currentRead, "late cleanup belongs only to its own request");
  assert.equal(reads, 3);
  fresh.resolve(json(ready(newNote, doneTime)));
  await currentRead;
  assert.deepEqual(controller.getSnapshot().note, newNote);
});

for (const stalled of ["response", "body"] as const) {
  test(`the 15-second note deadline aborts an actual fetch with a stalled ${stalled} and allows retry`, { timeout: 5_000 }, async t => {
    const received = deferred<void>();
    const headersReceived = deferred<void>();
    const disconnected = deferred<void>();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.setHeader("Content-Type", "application/json");
      if (requests === 1) {
        response.on("close", () => disconnected.resolve());
        if (stalled === "body") response.write('{"note":');
        received.resolve();
      } else response.end(JSON.stringify(ready(newNote, doneTime)));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/note`;
    let signal: AbortSignal | null | undefined;
    const controller = createLectureNoteController("lecture-a", true, (_url, init) => {
      signal = init?.signal;
      return fetch(url, init).then(response => { headersReceived.resolve(); return response; });
    });
    t.after(() => controller.dispose());
    controller.start();
    await received.promise;
    if (stalled === "body") { await headersReceived.promise; await setImmediate(); }
    const reading = controller.reload();
    assert.equal(reading, controller.reload());
    t.mock.timers.tick(14_999);
    assert.equal(signal?.aborted, false);
    t.mock.timers.tick(1);
    await reading;
    assert.equal(signal?.aborted, true);
    assert.equal(controller.getSnapshot().phase, "error");
    assert.equal(controller.getSnapshot().message, "Could not load the note. Please try again.");
    await disconnected.promise;
    await controller.reload();
    assert.equal(requests, 2);
    assert.deepEqual(controller.getSnapshot().note, newNote);
    assert.equal(controller.getSnapshot().message, "");
  });
}

test("a body that ignores abort cannot hold the note read slot or stop generation polling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const headers = deferred<Response>();
  const body = deferred<unknown>();
  const stalled = json({});
  stalled.json = () => body.promise;
  let reads = 0;
  const controller = createLectureNoteController("lecture-a", false, async () => {
    reads++;
    return reads === 1 ? json(waiting(oldNote)) : reads === 2 ? headers.promise : json(ready(newNote, doneTime));
  });
  t.after(() => controller.dispose());
  controller.start();
  await setImmediate();
  t.mock.timers.tick(3_000);
  await setImmediate();
  const pending = controller.reload();
  t.mock.timers.tick(12_000);
  headers.resolve(stalled);
  await setImmediate();
  t.mock.timers.tick(2_999);
  assert.equal(controller.getSnapshot().message, "");
  t.mock.timers.tick(1); // One deadline covers both waiting for headers and reading the body.
  await pending;
  assert.equal(reads, 2);
  assert.equal(controller.getSnapshot().phase, "generating");
  assert.equal(controller.getSnapshot().startedAt, startedAt);
  assert.deepEqual(controller.getSnapshot().note, oldNote);
  assert.equal(controller.getSnapshot().message, "노트를 불러오지 못했습니다. 다시 확인해 주세요.");
  t.mock.timers.tick(3_000);
  await setImmediate();
  assert.equal(reads, 3);
  assert.deepEqual(controller.getSnapshot().note, newNote);
  body.resolve(ready(oldNote));
  await setImmediate();
  assert.deepEqual(controller.getSnapshot().note, newNote, "a late body cannot overwrite the successful retry");
});

test("disposing a stalled read releases its callers without publishing a timeout error", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = createLectureNoteController("lecture-a", true, async () => new Promise<Response>(() => {}));
  controller.start();
  const pending = controller.reload();
  const snapshot = controller.getSnapshot();
  controller.dispose();
  await pending;
  t.mock.timers.tick(15_000);
  assert.equal(controller.getSnapshot(), snapshot);
  assert.equal(snapshot.message, "");
});

test("an inactive or live session never fetches or submits a note", async () => {
  let requests = 0;
  const controller = createLectureNoteController(null, false, async () => { requests += 1; return json({ note: null }); });
  controller.start();
  await controller.reload();
  await controller.generate(false);
  controller.dispose();
  assert.equal(requests, 0);
  assert.equal(controller.getSnapshot().phase, "none");
});
