import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) { try { return next(s + ".ts", c); } catch { throw e; } } } });
const { hasAnalyticsConsent, trackAnalytics } = await import("./analytics-client.ts");
test("analytics cannot interrupt recording when absent, denied or storage/dispatch fails", () => {
  const saved = new Map(["document", "localStorage", "window", "CustomEvent"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const set = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, value });
  let dispatched = 0;
  try {
    assert.doesNotThrow(() => trackAnalytics("recording_start"));
    set("document", { cookie: "lecue-analytics-v1=granted" });
    set("localStorage", { getItem: () => "denied" });
    set("window", { dispatchEvent: () => { dispatched++; throw new Error("Optional listener failed"); } });
    set("CustomEvent", class {});
    assert.equal(hasAnalyticsConsent(), false); trackAnalytics("recording_start"); assert.equal(dispatched, 0);
    set("localStorage", { getItem: () => "granted" });
    assert.equal(hasAnalyticsConsent(), true); assert.doesNotThrow(() => trackAnalytics("recording_start")); assert.equal(dispatched, 1);
    set("localStorage", { getItem: () => { throw new Error("Blocked storage"); } });
    assert.equal(hasAnalyticsConsent(), false); assert.doesNotThrow(() => trackAnalytics("answer_complete")); assert.equal(dispatched, 1);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
