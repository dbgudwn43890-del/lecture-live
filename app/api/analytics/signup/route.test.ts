import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (error) {
  for (const ext of [".ts", ".js"]) { try { return next(s + ext, c); } catch {} } throw error;
} } });
const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
let verified = true, signedIn = true, claimed = false, fail = false, calls = 0;
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, { namedExports: { createClient: async () => ({ auth: {
  getUser: async () => ({ data: { user: signedIn ? { id: userId, email: "fixture@example.test", email_confirmed_at: verified ? "2026-09-13T01:00:00Z" : null } : null }, error: null }),
  getClaims: async () => ({ data: { claims: { sub: userId, session_id: sessionId } }, error: null }),
} }) } });
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => ({ rpc: async (name: string, args: unknown) => {
  calls++; if (fail) throw new Error("private upstream details");
  assert.equal(name, "claim_analytics_signup_service"); assert.deepEqual(args, { p_user_id: userId, p_session_id: sessionId });
  const first = !claimed; claimed = true; return { data: first, error: null };
} }) } });
const { NextRequest } = await import("next/server.js");
const { POST } = await import("./route.ts");
function request(consent = "granted", origin = "https://www.lecue.app") {
  return new NextRequest("https://www.lecue.app/api/analytics/signup", { method: "POST", headers: { origin, cookie: `lecue-analytics-v1=${consent}` } });
}
test.beforeEach(() => { process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABCDEF1234"; verified = true; signedIn = true; claimed = false; fail = false; calls = 0; });
test("declined, anonymous, unverified, foreign-origin and disabled requests never claim", async () => {
  await POST(request("denied")); await POST(request("granted", "https://evil.test"));
  signedIn = false; await POST(request()); signedIn = true; verified = false; await POST(request());
  verified = true; delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID; await POST(request()); assert.equal(calls, 0);
});
test("multiple tabs get exactly one authorization and no identity is returned", async () => {
  const replies = await Promise.all(Array.from({ length: 8 }, async () => (await POST(request())).json()));
  assert.equal(replies.filter(x => x.claimed).length, 1);
  for (const reply of replies) assert.deepEqual(Object.keys(reply), ["claimed"]);
});
test("an existing receipt and a failed database never produce signup events or an auth error", async () => {
  claimed = true; assert.deepEqual(await (await POST(request())).json(), { claimed: false });
  fail = true; const result = await POST(request()); assert.equal(result.status, 200);
  assert.equal(await result.text(), '{"claimed":false}');
});
