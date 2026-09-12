import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
let effect: () => void | (() => void);
mock.module("react", { exports: { useRef: (value: unknown) => ({ current: value }), useEffect: (callback: typeof effect) => { effect = callback; } } });
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (error) { if (specifier.startsWith(".")) return next(specifier + ".ts", context); throw error; } } });
const { usePaymentReturn } = await import("./use-payment-return.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(responses: Array<Response | Error>, refreshResults = [true]) {
  const saved = new Map(["window", "history", "location", "sessionStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = new Map([["lecue-pending-payment", "txn_paid"]]);
  const timers: Array<() => Promise<void>> = [];
  const urls: string[] = [], notices: string[] = [];
  let refreshes = 0;
  mock.method(globalThis, "fetch", async () => { const next = responses.shift(); if (next instanceof Error) throw next; if (!next) throw new Error("Unexpected request"); return next; });
  mock.method(globalThis, "setTimeout", ((fn: () => Promise<void>) => { timers.push(fn); return 1; }) as any);
  mock.method(globalThis, "clearTimeout", (() => {}) as any);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: { addEventListener: () => {}, removeEventListener: () => {} } },
    location: { configurable: true, value: { search: "?classroom=keep&billing_tx=txn_paid", href: "https://www.lecue.app/classroom?classroom=keep&billing_tx=txn_paid#notes" } },
    history: { configurable: true, value: { state: { keep: true }, replaceState: (_state: unknown, _title: string, href: string) => urls.push(href) } },
    sessionStorage: { configurable: true, value: { getItem: (key: string) => values.get(key), removeItem: (key: string) => values.delete(key) } },
  });
  usePaymentReturn("en", async () => { refreshes++; return refreshResults.shift() ?? true; }, message => notices.push(message));
  const dispose = effect!();
  return { timers, values, urls, notices, refreshes: () => refreshes, dispose, cleanup: () => {
    dispose?.(); mock.restoreAll();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  } };
}
const status = (granted: boolean) => Response.json({ granted });

test("classroom silently waits for the owned grant and refreshes credits once", async () => {
  const app = setup([status(false), status(true)]);
  try {
    await flush();
    assert.equal(app.refreshes(), 0);
    assert.equal(app.values.size, 1);
    await app.timers.shift()!();
    assert.equal(app.refreshes(), 1);
    assert.deepEqual(app.urls, ["/classroom?classroom=keep#notes"]);
    assert.equal(app.values.size, 0);
    assert.deepEqual(app.notices, []);
  } finally { app.cleanup(); }
});
test("another account's return cannot refresh or claim purchased credits", async () => {
  const app = setup([new Response(null, { status: 404 })]);
  try { await flush(); assert.equal(app.refreshes(), 0); assert.equal(app.values.size, 0); assert.deepEqual(app.notices, []); }
  finally { app.cleanup(); }
});
test("network and credit-refresh failures retain recovery until the balance loads", async () => {
  const app = setup([new Error("offline"), status(true), status(true)], [false, true]);
  try {
    await flush(); await app.timers.shift()!();
    assert.equal(app.values.size, 1);
    assert.deepEqual(app.urls, []);
    await app.timers.shift()!();
    assert.equal(app.refreshes(), 2);
    assert.equal(app.values.size, 0);
    assert.deepEqual(app.notices, []);
  } finally { app.cleanup(); }
});
test("leaving the classroom cancels further payment checks", async () => {
  const app = setup([status(false), status(true)]);
  try {
    await flush(); app.dispose?.(); await app.timers.shift()!();
    assert.equal(app.refreshes(), 0); assert.equal(app.values.size, 1);
  } finally { app.cleanup(); }
});
