import assert from "node:assert/strict";
import test from "node:test";
const loadConfig = (variant: string) => import(`../../next.config.ts?ga4=${variant}`);

test("CSP only permits GA hosts when configured and preserves existing protections", async () => {
  const previous = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  try {
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
    const off = await loadConfig("off");
    const offHeaders = await off.default.headers();
    const offCsp = offHeaders.find((entry: { source: string }) => entry.source === "/:path*").headers.find((entry: { key: string }) => entry.key === "Content-Security-Policy").value;
    assert.doesNotMatch(offCsp, /googletagmanager|google-analytics/);
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-TEST123456";
    const on = await loadConfig("on");
    const onHeaders = await on.default.headers();
    const onCsp = onHeaders.find((entry: { source: string }) => entry.source === "/:path*").headers.find((entry: { key: string }) => entry.key === "Content-Security-Policy").value;
    assert.match(onCsp, /script-src[^;]*https:\/\/www\.googletagmanager\.com/);
    assert.match(onCsp, /connect-src[^;]*https:\/\/\*\.google-analytics\.com/);
    assert.match(onCsp, /frame-ancestors 'none'/);
    assert.match(onCsp, /object-src 'none'/);
    assert.doesNotMatch(onCsp, /https:\/\/\*\.google\.com|doubleclick/);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
    else process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = previous;
  }
});
