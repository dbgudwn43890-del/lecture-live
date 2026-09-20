import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { openNotePrintDetails, waitForNoteDiagrams } from "./note-print.ts";

const originalObserver = globalThis.MutationObserver;
afterEach(() => { globalThis.MutationObserver = originalObserver; });

function diagramFixture() {
  let pending = true;
  let notify = () => {};
  let disconnected = false;
  let observed: Node | undefined;
  class Observer {
    constructor(callback: MutationCallback) { notify = () => callback([], this as unknown as MutationObserver); }
    observe(node: Node) { observed = node; }
    disconnect() { disconnected = true; }
    takeRecords() { return []; }
  }
  globalThis.MutationObserver = Observer as unknown as typeof MutationObserver;
  const article = { querySelector(selector: string) { assert.equal(selector, "[data-note-diagram-pending]"); return pending ? {} : null; } } as unknown as HTMLElement;
  return { article, finish() { pending = false; notify(); }, unrelatedChange: () => notify(),
    get disconnected() { return disconnected; }, get observed() { return observed; } };
}

test("PDF waits for the current diagram DOM commit and ignores unrelated mutations", async () => {
  const fixture = diagramFixture();
  let completed = false;
  const result = waitForNoteDiagrams(fixture.article, new AbortController().signal).then(value => { completed = true; return value; });
  fixture.unrelatedChange();
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(fixture.observed, fixture.article);
  fixture.finish();
  assert.equal(await result, true);
  assert.equal(fixture.disconnected, true);
});

test("a note change or dialog close cancels a pending print without later completion", async () => {
  const fixture = diagramFixture();
  const request = new AbortController();
  const result = waitForNoteDiagrams(fixture.article, request.signal);
  request.abort();
  assert.equal(await result, false);
  assert.equal(fixture.disconnected, true);
  fixture.finish();
  assert.equal(await result, false);
});

test("an unresponsive diagram stops waiting after five seconds and a later attempt can succeed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = diagramFixture();
  const result = waitForNoteDiagrams(fixture.article, new AbortController().signal);
  t.mock.timers.tick(5_000);
  assert.equal(await result, false);
  assert.equal(fixture.disconnected, true);
  fixture.finish();
  assert.equal(await waitForNoteDiagrams(fixture.article, new AbortController().signal), true);
});

test("already prepared notes print immediately and already cancelled requests never print", async () => {
  const fixture = diagramFixture();
  fixture.finish();
  assert.equal(await waitForNoteDiagrams(fixture.article, new AbortController().signal), true);
  const request = new AbortController(); request.abort();
  assert.equal(await waitForNoteDiagrams(fixture.article, request.signal), false);
  assert.equal(fixture.observed, undefined);
});

test("print expansion restores closed disclosures and leaves user-open disclosures intact", () => {
  const hint = { open: false }, solution = { open: false }, diagram = { open: false }, legacy = { open: false };
  const alreadyOpen = { open: true };
  const article = { querySelectorAll(selector: string) {
    assert.ok(selector.includes(".note-original-answers[data-legacy='true']:not([open])"));
    assert.ok(selector.includes(".note-diagram-details:not([open])"));
    assert.ok(selector.includes(".answer-check details:not([open])"));
    assert.ok(!selector.includes("note-original-questions"));
    return [hint, solution, diagram, legacy, alreadyOpen].filter(detail => !detail.open);
  } } as unknown as ParentNode;
  const restore = openNotePrintDetails(article);
  assert.ok([hint, solution, diagram, legacy, alreadyOpen].every(detail => detail.open));
  restore();
  assert.ok([hint, solution, diagram, legacy].every(detail => !detail.open));
  assert.equal(alreadyOpen.open, true);
});
