import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import vm from "node:vm";
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (error) {
  for (const ext of [".ts", ".js"]) { try { return next(s + ext, c); } catch {} } throw error;
} } });
const { NextRequest } = await import("next/server.js");
const { GET } = await import("./route.ts");
test("no consent or missing configuration returns no Google document", () => {
  process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABCDEF1234";
  assert.equal(GET(new NextRequest("https://www.lecue.app/api/analytics/frame")).status, 204);
  delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  assert.equal(GET(new NextRequest("https://www.lecue.app/api/analytics/frame", { headers: { cookie: "lecue-analytics-v1=granted" } })).status, 204);
});
test("generated Google document enforces consent, event allowlist, URL sanitation and withdrawal (no network)", async () => {
  process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABCDEF1234";
  const response = GET(new NextRequest("https://www.lecue.app/api/analytics/frame", { headers: { cookie: "lecue-analytics-v1=granted" } }));
  const html = await response.text();
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const code = html.match(/<script>([\s\S]*)<\/script>/)![1];
  function run(granted: boolean) {
    const listeners: Record<string, (event?: unknown) => void> = {};
    const scripts: object[] = [];
    let navigated = "";
    const parent = { postMessage() {} };
    const context: Record<string, any> = { URL, parent,
      location: { origin: "https://www.lecue.app", replace: (url: string) => navigated = url },
      document: { cookie: "lecue-analytics-v1=granted", createElement: () => ({}), head: { append: (s: object) => scripts.push(s) } },
      localStorage: { getItem: () => granted ? "granted" : "denied" },
      addEventListener: (name: string, listener: (e?: unknown) => void) => listeners[name] = listener,
    };
    context.window = context;
    vm.runInNewContext(code, context);
    return { context, scripts, listeners, parent, navigated: () => navigated };
  }
  assert.equal(run(false).scripts.length, 0);
  const f = run(true);
  assert.equal(f.scripts.length, 1);
  const message = { source: f.parent, origin: "https://www.lecue.app", data: { type: "lecue-measure", event: "sign_up", location: "https://www.lecue.app/en/classroom?session=secret&email=private@example.test&gclid=AbCdEfGhIj12345#question", email: "private@example.test" } };
  f.listeners.message(message);
  const sent = JSON.stringify(f.context.dataLayer);
  assert.ok(sent.includes('sign_up')); assert.ok(sent.includes('gclid=AbCdEfGhIj12345'));
  assert.ok(!/private|secret|question/.test(sent));
  const length = f.context.dataLayer.length;
  f.listeners.message({ ...message, origin: "https://evil.test" });
  f.listeners.message({ ...message, data: { ...message.data, event: "private_question" } });
  assert.equal(f.context.dataLayer.length, length);
  f.context.localStorage.getItem = () => "denied";
  f.listeners.storage(); f.listeners.message(message);
  assert.equal(f.navigated(), "about:blank"); assert.equal(f.context.dataLayer.length, length);
  assert.equal(f.context["ga-disable-G-ABCDEF1234"], true);
});
