import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const OWNER = randomUUID();
const ROOM = randomUUID();
const INVITE = "i".repeat(43);
const PHONE = "p".repeat(43);
const OWNER_TOKEN = "o".repeat(43);
const SECRET = "test-internal-secret-never-return-to-browser";
const ORIGIN = "https://www.lecue.app";
let userId: string | null = OWNER;
let consent = true;
let authCalls = 0;
let consentCalls = 0;
let rateAllowed = true;
let rates: Array<{ key: string; limit: number; windowMs: number }> = [];
let requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
let upstream: (body: Record<string, unknown>, init: RequestInit) => Promise<Response>;
const future = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
const realFetch = globalThis.fetch;
const savedEnv = Object.fromEntries(["PHONE_MIC_RELAY_URL", "PHONE_MIC_SECRET", "VERCEL", "VERCEL_URL", "VERCEL_ENV", "NODE_ENV"].map(key => [key, process.env[key]]));

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    for (const extension of [".ts", ".js"]) { try { return nextResolve(`${specifier}${extension}`, context); } catch { /* next */ } }
    throw error;
  }
} });
mock.module(pathToFileURL("app/lib/auth.ts").href, { namedExports: { getAuthenticatedUserId: async () => { authCalls++; return userId; } } });
mock.module(pathToFileURL("app/lib/consent.ts").href, { namedExports: { hasRecordingConsents: async (client: unknown) => {
  consentCalls++; assert.deepEqual(client, { ownerRls: true }); return consent;
} } });
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, { namedExports: { createClient: async () => ({ ownerRls: true }) } });
mock.module(pathToFileURL("app/lib/rate-limit.ts").href, { namedExports: { checkSharedRateLimit: async (key: string, limit: number, windowMs: number) => {
  rates.push({ key, limit, windowMs }); return { allowed: rateAllowed, remaining: 0, retryAfterSeconds: 17 };
} } });
globalThis.fetch = (async (input, init = {}) => {
  const body = JSON.parse(String(init.body));
  requests.push({ url: String(input), init, body });
  return upstream(body, init);
}) as typeof fetch;
const { POST, DELETE } = await import("./route.ts");

function request(body: unknown = { action: "create" }, options: RequestInit & { url?: string } = {}) {
  const { url = `${ORIGIN}/api/phone-mic`, ...init } = options;
  return new Request(url, { method: "POST", body: JSON.stringify(body), ...init,
    headers: { "Content-Type": "application/json", Origin: new URL(url).origin, ...options.headers },
  });
}
function claim(options?: RequestInit & { url?: string }) { return request({ action: "claim", roomId: ROOM, inviteToken: INVITE, phoneToken: PHONE }, options); }
function remove(options?: RequestInit) { return request({ roomId: ROOM, ownerToken: OWNER_TOKEN }, { method: "DELETE", ...options }); }
async function error(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.code, code);
  const text = JSON.stringify(body);
  for (const secret of [SECRET, INVITE, PHONE, OWNER_TOKEN, "provider-private-key"]) assert.ok(!text.includes(secret));
  return body;
}

test.beforeEach(() => {
  userId = OWNER; consent = true; authCalls = 0; consentCalls = 0; rateAllowed = true; rates = []; requests = [];
  process.env.PHONE_MIC_RELAY_URL = "https://phone-relay.lecue.test";
  process.env.PHONE_MIC_SECRET = SECRET;
  Object.assign(process.env, { NODE_ENV: "test" });
  delete process.env.VERCEL; delete process.env.VERCEL_URL; delete process.env.VERCEL_ENV;
  upstream = async (body, init) => Response.json(init.method === "DELETE" ? { ok: true } : {
    roomId: body.roomId, inviteExpiresAt: future(120_000), expiresAt: future(10_800_000),
  });
});
test.after(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test("consented owner creates fresh scoped capabilities without forwarding login or internal credentials", async () => {
  const response = await POST(request({ action: "create", ownerId: "spoofed", ownerToken: OWNER_TOKEN }, { headers: { Cookie: "owner-session=private" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.match(body.roomId, /^[a-f0-9-]{36}$/);
  assert.match(body.ownerToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(body.inviteToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(body.ownerToken, body.inviteToken);
  assert.notEqual(body.ownerToken, OWNER_TOKEN);
  assert.equal(body.relayUrl, `wss://phone-relay.lecue.test/v1/rooms/${body.roomId}/socket`);
  assert.equal(JSON.stringify(body).includes(SECRET), false);
  assert.equal(JSON.stringify(body).includes(OWNER), false);
  assert.equal(authCalls, 1); assert.equal(consentCalls, 1);
  assert.deepEqual(rates, [{ key: `phone-mic:create:${OWNER}`, limit: 10, windowMs: 60_000 }]);
  assert.equal(requests[0].url, "https://phone-relay.lecue.test/v1/rooms");
  assert.deepEqual(requests[0].body, { roomId: body.roomId, ownerId: OWNER, ownerToken: body.ownerToken, inviteToken: body.inviteToken });
  assert.deepEqual(requests[0].init.headers, { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" });
  assert.equal(requests[0].init.redirect, "error"); assert.equal(requests[0].init.cache, "no-store");
});

test("creation requires authenticated ownership and recording consent", async () => {
  userId = null;
  await error(await POST(request()), 401, "SIGN_IN_REQUIRED");
  assert.equal(consentCalls, 0); assert.equal(requests.length, 0);
  userId = OWNER; consent = false;
  const result = await error(await POST(request({}, { headers: { "X-Site-Locale": "en" }, body: JSON.stringify({ action: "create" }) })), 403, "CONSENT_REQUIRED");
  assert.match(result.error, /age and recording agreements/);
  assert.equal(requests.length, 0);
});

test("anonymous claim forwards only the supplied phone capability and omits every owner credential", async () => {
  userId = null; consent = false;
  upstream = async () => Response.json({ roomId: ROOM, expiresAt: future(10_800_000), ownerToken: OWNER_TOKEN, internalSecret: SECRET });
  const response = await POST(claim());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "relayUrl", "roomId"]);
  assert.equal(body.roomId, ROOM);
  assert.equal(body.relayUrl, `wss://phone-relay.lecue.test/v1/rooms/${ROOM}/socket`);
  assert.equal(authCalls, 0); assert.equal(consentCalls, 0);
  assert.equal(requests[0].url, `https://phone-relay.lecue.test/v1/rooms/${ROOM}/claim`);
  assert.deepEqual(requests[0].body, { roomId: ROOM, inviteToken: INVITE, phoneToken: PHONE });
});

test("delete binds the owner token to the authenticated owner and remains available without consent", async () => {
  consent = false;
  assert.equal((await DELETE(remove())).status, 200);
  assert.equal(consentCalls, 0);
  assert.equal(requests[0].url, `https://phone-relay.lecue.test/v1/rooms/${ROOM}`);
  assert.equal(requests[0].init.method, "DELETE");
  assert.deepEqual(requests[0].body, { ownerId: OWNER, ownerToken: OWNER_TOKEN });
  assert.deepEqual(rates, [{ key: `phone-mic:delete:${OWNER}`, limit: 30, windowMs: 60_000 }]);
  userId = null;
  await error(await DELETE(remove()), 401, "SIGN_IN_REQUIRED");
  assert.equal(requests.length, 1);
});

test("strict origin rejects missing, null, cross-site and spoofed forwarded hosts before touching credentials", async () => {
  for (const origin of ["", "null", "https://evil.test", "https://lecue.app"]) {
    await error(await POST(request({ action: "create" }, { headers: { Origin: origin, "X-Forwarded-Host": "www.lecue.app" } })), 403, "INVALID_ORIGIN");
  }
  await error(await POST(claim({ url: "https://evil.test/api/phone-mic", headers: { "X-Forwarded-Host": "www.lecue.app" } })), 403, "INVALID_ORIGIN");
  await error(await DELETE(remove({ headers: { Origin: "https://evil.test" } })), 403, "INVALID_ORIGIN");
  assert.equal(requests.length, 0); assert.equal(authCalls, 0); assert.equal(rates.length, 0);
});

test("allows exact production or configured preview origins, and local development only outside production", async () => {
  assert.equal((await POST(claim({ url: "https://lecue.app/api/phone-mic" }))).status, 200);
  assert.equal((await POST(claim({ url: "http://localhost:3000/api/phone-mic" }))).status, 200);
  Object.assign(process.env, { NODE_ENV: "production" });
  await error(await POST(claim({ url: "http://localhost:3000/api/phone-mic" })), 403, "INVALID_ORIGIN");
  process.env.VERCEL = "1"; process.env.VERCEL_URL = "lecue-candidate-example.vercel.app";
  assert.equal((await POST(claim({ url: "https://lecue-candidate-example.vercel.app/api/phone-mic" }))).status, 200);
  await error(await POST(claim({ url: "https://some-other-project.vercel.app/api/phone-mic" })), 403, "INVALID_ORIGIN");
});

test("shared owner and anonymous limits block Worker access and supply Retry-After", async () => {
  rateAllowed = false;
  for (const response of [await POST(request()), await POST(claim()), await DELETE(remove())]) {
    await error(response, 429, "TOO_MANY_REQUESTS");
    assert.equal(response.headers.get("retry-after"), "17");
  }
  assert.equal(requests.length, 0);
});

test("claim limiter ignores spoofable proxy headers and validates the configured platform IP", async () => {
  const hash = (value: string) => `phone-mic:claim:${createHash("sha256").update(value).digest("hex")}`;
  await POST(claim({ headers: { "X-Forwarded-For": "1.2.3.4", "X-Real-IP": "1.2.3.5", "X-Vercel-Forwarded-For": "1.2.3.6" } }));
  assert.equal(rates.at(-1)?.key, hash("unknown"));
  process.env.VERCEL = "1";
  await POST(claim({ headers: { "X-Vercel-Forwarded-For": "2001:db8::1" } }));
  assert.equal(rates.at(-1)?.key, hash("2001:db8::1"));
  await POST(claim({ headers: { "X-Vercel-Forwarded-For": "1.2.3.4, 5.6.7.8" } }));
  assert.equal(rates.at(-1)?.key, hash("unknown"));
});

test("rejects malformed bodies, invalid UUIDs and capabilities without making internal requests", async () => {
  for (const body of [null, [], "claim", {}, { action: "unknown" },
    { action: "claim", roomId: "../another-room", inviteToken: INVITE, phoneToken: PHONE },
    { action: "claim", roomId: ROOM, inviteToken: "i".repeat(42), phoneToken: PHONE },
    { action: "claim", roomId: ROOM, inviteToken: INVITE, phoneToken: "!".repeat(43) }]) {
    await error(await POST(request(body)), 400, "INVALID_REQUEST");
  }
  await error(await DELETE(request({ roomId: ROOM, ownerToken: "invalid" }, { method: "DELETE" })), 400, "INVALID_REQUEST");
  await error(await POST(request({}, { body: "{" })), 400, "INVALID_REQUEST");
  assert.equal(requests.length, 0);
});

test("enforces byte limits for Content-Length and streamed bodies, even with a forged short length", async () => {
  await error(await POST(request({}, { headers: { "Content-Length": "2049" } })), 413, "BODY_TOO_LARGE");
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"action":"create","padding":"')); controller.enqueue(new Uint8Array(2_049)); },
    cancel() { cancelled = true; },
  });
  const streamed = new Request(`${ORIGIN}/api/phone-mic`, { method: "POST", headers: { Origin: ORIGIN, "Content-Length": "2" }, body: stream, duplex: "half" } as RequestInit);
  await error(await POST(streamed), 413, "BODY_TOO_LARGE");
  assert.equal(cancelled, true); assert.equal(requests.length, 0);
});

test("relay configuration fails closed for insecure URLs, embedded credentials, paths, queries and absent secrets", async () => {
  for (const url of ["", "http://phone-relay.test", "https://user:pass@phone-relay.test", "https://phone-relay.test/path", "https://phone-relay.test?secret=x", "https://phone-relay.test#x"]) {
    process.env.PHONE_MIC_RELAY_URL = url;
    await error(await POST(claim()), 503, "UNAVAILABLE");
  }
  process.env.PHONE_MIC_RELAY_URL = "https://phone-relay.test";
  for (const secret of ["", "too-short", `${SECRET}\n`]) { process.env.PHONE_MIC_SECRET = secret; await error(await POST(claim()), 503, "UNAVAILABLE"); }
  assert.equal(requests.length, 0);
});

test("Worker failures expose only whitelisted status/code pairs and localized actionable messages", async () => {
  for (const [code, status] of Object.entries({ INVALID_REQUEST: 400, UNAUTHORIZED: 401, ROOM_NOT_FOUND: 404, INVITE_EXPIRED: 410,
    ROOM_EXPIRED: 410, INVITE_CLAIMED: 409, ROOM_CLOSED: 410, PEER_ALREADY_CONNECTED: 409, UNAVAILABLE: 503 })) {
    upstream = async () => Response.json({ code, error: SECRET, token: PHONE, providerKey: "provider-private-key" }, { status });
    const result = await error(await POST(claim({ headers: { "X-Site-Locale": "en" } })), status, code);
    assert.match(result.error, /[a-z]/);
  }
  upstream = async () => Response.json({ code: "ROOM_EXPIRED", error: SECRET }, { status: 500 });
  await error(await POST(claim()), 503, "UNAVAILABLE");
  upstream = async () => Response.json({ code: SECRET }, { status: 401 });
  await error(await POST(claim()), 503, "UNAVAILABLE");
});

test("malformed, oversized and unexpected successful Worker results never leak upstream data", async () => {
  for (const result of [{ roomId: randomUUID(), expiresAt: future(60_000) }, { roomId: ROOM, expiresAt: "invalid" },
    { roomId: ROOM, expiresAt: new Date(0).toISOString() }]) {
    upstream = async () => Response.json(result);
    await error(await POST(claim()), 503, "UNAVAILABLE");
  }
  upstream = async () => new Response(SECRET);
  await error(await POST(claim()), 503, "UNAVAILABLE");
  upstream = async () => Response.json({ huge: SECRET.repeat(100) });
  await error(await POST(claim()), 503, "UNAVAILABLE");
  upstream = async () => { throw new Error(SECRET); };
  await error(await POST(claim()), 503, "UNAVAILABLE");
  upstream = async () => Response.json({ ok: false, ownerToken: OWNER_TOKEN });
  await error(await DELETE(remove()), 503, "UNAVAILABLE");
});

test("creation verifies server room binding and invitation expiry before returning capabilities", async () => {
  upstream = async body => Response.json({ roomId: body.roomId, inviteExpiresAt: future(120_000), expiresAt: future(60_000), secret: SECRET });
  await error(await POST(request()), 503, "UNAVAILABLE");
  upstream = async () => Response.json({ roomId: ROOM, inviteExpiresAt: future(60_000), expiresAt: future(120_000) });
  await error(await POST(request()), 503, "UNAVAILABLE");
});

test("request cancellation aborts internal fetch and settles even if the upstream ignores cancellation", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  upstream = async () => { started(); return new Promise<Response>(() => {}); };
  const pending = POST(claim({ signal: controller.signal }));
  await ready;
  controller.abort();
  await error(await pending, 499, "REQUEST_CANCELLED");
  assert.equal(requests[0].init.signal?.aborted, true);
});

test("eight-second deadline bounds an upstream that never settles", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  upstream = async () => { started(); return new Promise<Response>(() => {}); };
  const pending = POST(claim());
  await ready;
  context.mock.timers.tick(8_000);
  await error(await pending, 503, "UNAVAILABLE");
  assert.equal(requests[0].init.signal?.aborted, true);
});

test("an already aborted request cannot create a room", async () => {
  const controller = new AbortController(); controller.abort();
  await error(await POST(request({ action: "create" }, { signal: controller.signal })), 499, "REQUEST_CANCELLED");
  assert.equal(requests.length, 0);
});

test("room creation uses only two opaque owner slots, with fresh capabilities and no replacement", async () => {
  const rooms = new Map<string, Record<string, unknown>>();
  upstream = async body => {
    if (rooms.has(body.roomId as string)) return Response.json({ code: "ROOM_BUSY" }, { status: 409 });
    rooms.set(body.roomId as string, body);
    return Response.json({ roomId: body.roomId, inviteExpiresAt: future(120_000), expiresAt: future(10_800_000) });
  };
  const attempts = await Promise.all(Array.from({ length: 6 }, () => POST(request())));
  assert.equal(attempts.filter(response => response.status === 200).length, 2);
  for (const response of attempts.filter(response => response.status !== 200)) await error(response, 409, "OWNER_ROOMS_FULL");
  assert.equal(rooms.size, 2);
  assert.equal(new Set(requests.map(request => request.body.roomId)).size, 2);
  const first = [...rooms.values()][0];
  assert.notEqual(first.roomId, OWNER);
  rooms.delete(first.roomId as string);
  const reused = await (await POST(request())).json();
  assert.equal(reused.roomId, first.roomId);
  assert.notEqual(reused.ownerToken, first.ownerToken);
  assert.notEqual(reused.inviteToken, first.inviteToken);
  userId = "33333333-3333-4333-8333-333333333333";
  const other = await (await POST(request())).json();
  assert.ok(![...rooms.values()].filter(room => room.ownerId === OWNER).some(room => room.roomId === other.roomId));
});

test("ambiguous create failure does not allocate the other slot or disclose capabilities", async () => {
  upstream = async () => { throw new Error("response lost after create"); };
  await error(await POST(request()), 503, "UNAVAILABLE");
  assert.equal(requests.length, 1);
});
