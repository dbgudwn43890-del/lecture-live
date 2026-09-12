import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

mock.module("react", { exports: { useState: (initial: unknown) => [initial, () => {}], useRef: (initial: unknown) => ({ current: initial }), useEffect: () => {} } });
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (error) { if (specifier.startsWith(".")) return next(specifier + ".ts", context); throw error; } } });
const { usePaddleCheckout } = await import("./use-paddle-checkout.ts");

function setup(locale: "ko" | "en" = "ko", closeThrows = false) {
  const trace: string[] = [];
  let callback: (event: any) => void = () => {};
  let settings: any;
  const values = new Map<string, string>();
  mock.method(globalThis, "fetch", async () => { throw new Error("A browser event cannot grant credits"); });
  const saved = new Map(["window", "document", "location", "sessionStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = "live_test";
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: { Paddle: { Initialize: (options: any) => { callback = options.eventCallback; settings = options.checkout.settings; }, Checkout: { close: () => { trace.push("close"); if (closeThrows) throw new Error("Frame gone"); } } } } },
    document: { configurable: true, value: { documentElement: { dataset: { theme: "light" } } } },
    location: { configurable: true, value: { origin: "https://www.lecue.app", search: "?_ptxn=txn_link", replace: (href: string) => trace.push(href) } },
    sessionStorage: { configurable: true, value: { setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } },
  });
  const hook = usePaddleCheckout(locale, () => trace.push("granted"), { enabled: true, signedIn: true });
  hook.initializePaddle();
  return { trace, values, settings, event: (name: string, transaction_id = "txn_paid") => callback({ name, data: { transaction_id } }), cleanup: () => {
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    if (token === undefined) delete process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN; else process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = token;
    mock.restoreAll();
  } };
}

test("completed checkout closes and returns immediately without waiting for fulfillment", () => {
  const app = setup();
  try {
    app.event("checkout.completed");
    assert.deepEqual(app.trace, ["close", "/classroom?lang=ko&billing_tx=txn_paid"]);
    assert.equal(app.values.get("lecue-pending-payment"), "txn_paid");
    assert.equal(app.settings.successUrl, "https://www.lecue.app/classroom?lang=ko&billing_tx=txn_link");
  } finally { app.cleanup(); }
});
test("closing an already removed Paddle frame does not strand an English buyer", () => {
  const app = setup("en", true);
  try { app.event("checkout.completed"); assert.deepEqual(app.trace, ["close", "/en/classroom?lang=en&billing_tx=txn_paid"]); }
  finally { app.cleanup(); }
});
test("failed, canceled, or initiated payments never redirect to the classroom", () => {
  const app = setup();
  try {
    for (const event of ["checkout.payment.initiated", "checkout.payment.failed", "checkout.error", "checkout.closed"]) app.event(event);
    assert.deepEqual(app.trace, []);
    assert.equal(app.values.size, 0);
  } finally { app.cleanup(); }
});
