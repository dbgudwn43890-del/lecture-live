import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

import { getAuthenticatedUserId } from "../../lib/auth";
import { isUuid } from "../../lib/billing";
import { hasRecordingConsents } from "../../lib/consent";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 15;

const MAX_BODY_BYTES = 2_048;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ERRORS = {
  INVALID_REQUEST: [400, "휴대폰 연결 요청을 확인해 주세요.", "Check the phone microphone connection request."],
  INVALID_ORIGIN: [403, "Lecue 페이지에서 다시 연결해 주세요.", "Reconnect from the Lecue page."],
  SIGN_IN_REQUIRED: [401, "컴퓨터에서 로그인한 뒤 휴대폰을 연결해 주세요.", "Sign in on your computer, then connect your phone."],
  CONSENT_REQUIRED: [403, "컴퓨터에서 만 14세 확인과 녹음 고지에 동의한 뒤 연결해 주세요.", "Accept the age and recording agreements on your computer before connecting."],
  TOO_MANY_REQUESTS: [429, "연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", "Too many connection requests. Please try again shortly."],
  BODY_TOO_LARGE: [413, "휴대폰 연결 요청이 너무 큽니다. QR 코드를 다시 스캔해 주세요.", "The connection request is too large. Scan the QR code again."],
  UNAUTHORIZED: [401, "연결 요청이 허용되지 않았습니다. 컴퓨터에서 새 QR 코드를 만들어 주세요.", "The connection request was not authorized. Create a new QR code on your computer."],
  ROOM_NOT_FOUND: [404, "휴대폰 연결을 찾을 수 없습니다. 컴퓨터에서 새 QR 코드를 만들어 주세요.", "This phone connection was not found. Create a new QR code on your computer."],
  INVITE_EXPIRED: [410, "QR 코드의 연결 시간이 지났습니다. 컴퓨터에서 새 QR 코드를 만들어 주세요.", "This QR code has expired. Create a new QR code on your computer."],
  ROOM_EXPIRED: [410, "휴대폰 연결 시간이 끝났습니다. 컴퓨터에서 다시 연결해 주세요.", "This phone connection has expired. Reconnect from your computer."],
  INVITE_CLAIMED: [409, "이미 사용한 QR 코드입니다. 연결된 휴대폰을 사용하거나 컴퓨터에서 새 QR 코드를 만들어 주세요.", "This QR code has already been used. Use the connected phone or create a new QR code on your computer."],
  ROOM_CLOSED: [410, "휴대폰 연결이 종료됐습니다. 컴퓨터에서 다시 연결해 주세요.", "This phone connection has ended. Reconnect from your computer."],
  ROOM_BUSY: [409, "사용 중인 휴대폰 연결입니다.", "This phone connection is in use."],
  OWNER_ROOMS_FULL: [409, "이 계정에서 휴대폰 연결 두 개가 이미 열려 있습니다. 열린 연결을 종료하거나, QR을 연결하지 않았다면 3분 뒤 다시 시도해 주세요.", "Two phone connections are already open for this account. Close one, or wait three minutes if its QR code was not connected."],
  PEER_ALREADY_CONNECTED: [409, "이미 연결된 기기가 있습니다. 해당 기기의 연결을 종료한 뒤 다시 시도해 주세요.", "A device is already connected. Disconnect that device before trying again."],
  REQUEST_CANCELLED: [499, "연결 요청이 취소됐습니다.", "The connection request was cancelled."],
  UNAVAILABLE: [503, "휴대폰 연결을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.", "The phone connection could not be prepared. Please try again shortly."],
} as const;
type ErrorCode = keyof typeof ERRORS;
const WORKER_ERRORS = new Set<ErrorCode>([
  "ROOM_BUSY", "INVALID_REQUEST", "UNAUTHORIZED", "ROOM_NOT_FOUND", "INVITE_EXPIRED", "ROOM_EXPIRED",
  "INVITE_CLAIMED", "ROOM_CLOSED", "PEER_ALREADY_CONNECTED", "UNAVAILABLE",
]);

class ConnectionError extends Error {
  readonly code: ErrorCode;
  readonly retryAfter?: number;
  constructor(code: ErrorCode, retryAfter?: number) { super(code); this.code = code; this.retryAfter = retryAfter; }
}

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders } });
}

function trustedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return false;
  if (origin === "https://www.lecue.app" || origin === "https://lecue.app") return true;
  if (process.env.VERCEL === "1" && process.env.VERCEL_URL
    && /^[a-z0-9-]+\.vercel\.app$/i.test(process.env.VERCEL_URL)
    && origin === `https://${process.env.VERCEL_URL}`) return true;
  return process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production"
    && (origin === "http://localhost:3000" || origin === "http://127.0.0.1:3000");
}

function relayConfiguration() {
  const secret = process.env.PHONE_MIC_SECRET ?? "";
  try {
    const url = new URL(process.env.PHONE_MIC_RELAY_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
      || url.search || url.hash || !/^[\x21-\x7e]{32,256}$/.test(secret)) return null;
    return { origin: url.origin, secret };
  } catch { return null; }
}

// Only the configured Vercel ingress can supply this platform-owned header.
// An unrecognized deployment shares a bounded bucket rather than trusting a
// caller-controlled X-Forwarded-For / X-Real-IP value.
function claimRateKey(request: Request) {
  const value = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for")?.trim() : null;
  const address = value && isIP(value) ? value : "unknown";
  return `phone-mic:claim:${createHash("sha256").update(address).digest("hex")}`;
}

async function rateLimit(key: string, limit: number) {
  const result = await checkSharedRateLimit(key, limit, 60_000);
  if (!result.allowed) throw new ConnectionError("TOO_MANY_REQUESTS", result.retryAfterSeconds);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readJson(message: Request | Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (Number(message.headers.get("content-length")) > MAX_BODY_BYTES) throw new ConnectionError("BODY_TOO_LARGE");
  const reader = message.body?.getReader();
  if (!reader) throw new ConnectionError("INVALID_REQUEST");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new ConnectionError("BODY_TOO_LARGE");
      text += decoder.decode(value, { stream: true });
    }
    const body: unknown = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ConnectionError("INVALID_REQUEST");
    return body as Record<string, unknown>;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function workerRequest(configuration: NonNullable<ReturnType<typeof relayConfiguration>>, path: string,
  method: "POST" | "DELETE", body: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  try {
    const response = await abortable(fetch(`${configuration.origin}${path}`, {
      method, headers: { "Authorization": `Bearer ${configuration.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal, redirect: "error", cache: "no-store",
    }), signal);
    let result: Record<string, unknown>;
    try { result = await readJson(response, signal); }
    catch { throw new ConnectionError("UNAVAILABLE"); }
    if (!response.ok) {
      const code = typeof result.code === "string" ? result.code as ErrorCode : "UNAVAILABLE";
      throw new ConnectionError(WORKER_ERRORS.has(code) && ERRORS[code][0] === response.status ? code : "UNAVAILABLE");
    }
    return result;
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError("UNAVAILABLE");
  }
}

function expiresAt(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && Date.parse(value) > Date.now() && new Date(value).toISOString() === value;
}

async function handle(request: Request, method: "POST" | "DELETE", signal: AbortSignal) {
  if (!trustedOrigin(request)) throw new ConnectionError("INVALID_ORIGIN");
  let body: Record<string, unknown>;
  try { body = await readJson(request, signal); }
  catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError("INVALID_REQUEST");
  }
  const configuration = relayConfiguration();
  if (!configuration) throw new ConnectionError("UNAVAILABLE");
  const relayUrl = (roomId: string) => `${configuration.origin.replace(/^https:/, "wss:")}/v1/rooms/${roomId}/socket`;

  if (method === "POST" && body.action === "claim") {
    await rateLimit(claimRateKey(request), 30);
    if (!isUuid(body.roomId) || typeof body.inviteToken !== "string" || !TOKEN.test(body.inviteToken)
      || typeof body.phoneToken !== "string" || !TOKEN.test(body.phoneToken)) throw new ConnectionError("INVALID_REQUEST");
    const result = await workerRequest(configuration, `/v1/rooms/${body.roomId}/claim`, "POST", {
      roomId: body.roomId, inviteToken: body.inviteToken, phoneToken: body.phoneToken,
    }, signal);
    if (result.roomId !== body.roomId || !expiresAt(result.expiresAt)) throw new ConnectionError("UNAVAILABLE");
    return json({ roomId: body.roomId, relayUrl: relayUrl(body.roomId), expiresAt: result.expiresAt });
  }
  if (method === "POST" && body.action !== "create") throw new ConnectionError("INVALID_REQUEST");
  if (method === "DELETE" && (!isUuid(body.roomId) || typeof body.ownerToken !== "string" || !TOKEN.test(body.ownerToken))) {
    throw new ConnectionError("INVALID_REQUEST");
  }
  const ownerId = await getAuthenticatedUserId();
  if (!ownerId) throw new ConnectionError("SIGN_IN_REQUIRED");
  await rateLimit(`phone-mic:${method === "DELETE" ? "delete" : "create"}:${ownerId}`, method === "DELETE" ? 30 : 10);

  if (method === "DELETE") {
    const result = await workerRequest(configuration, `/v1/rooms/${body.roomId}`, "DELETE", { ownerId, ownerToken: body.ownerToken }, signal);
    if (result.ok !== true) throw new ConnectionError("UNAVAILABLE");
    return json({ ok: true });
  }
  if (!(await hasRecordingConsents(await createClient()))) throw new ConnectionError("CONSENT_REQUIRED");
  // Two stable opaque room slots bound concurrent relays per account.
  // The Durable Object serializes create atomically. Fresh tokens on reuse keep
  // expired invitations and owner capabilities from reaching a later connection.
  for (let slot = 0; slot < 2; slot++) {
    const digest = createHmac("sha256", configuration.secret).update(`phone-room:v1:${ownerId}:${slot}`).digest();
    digest[6] = (digest[6] & 0x0f) | 0x40;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString("hex");
    const roomId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    const ownerToken = randomBytes(32).toString("base64url");
    const inviteToken = randomBytes(32).toString("base64url");
    let result: Record<string, unknown>;
    try {
      result = await workerRequest(configuration, "/v1/rooms", "POST", { roomId, ownerId, ownerToken, inviteToken }, signal);
    } catch (error) {
      if (error instanceof ConnectionError && error.code === "ROOM_BUSY") continue;
      // An ambiguous timeout may have created this room. Leave its short
      // unclaimed expiry intact instead of allocating another slot speculatively.
      throw error;
    }
    if (result.roomId !== roomId || !expiresAt(result.expiresAt) || !expiresAt(result.inviteExpiresAt)
      || Date.parse(result.inviteExpiresAt) > Date.parse(result.expiresAt)) throw new ConnectionError("UNAVAILABLE");
    return json({ roomId, ownerToken, inviteToken, relayUrl: relayUrl(roomId), inviteExpiresAt: result.inviteExpiresAt, expiresAt: result.expiresAt });
  }
  throw new ConnectionError("OWNER_ROOMS_FULL");
}

async function respond(request: Request, method: "POST" | "DELETE") {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 8_000);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  try {
    return await abortable(handle(request, method, signal), signal);
  } catch (error) {
    const failure = request.signal.aborted ? new ConnectionError("REQUEST_CANCELLED")
      : signal.aborted ? new ConnectionError("UNAVAILABLE")
      : error instanceof ConnectionError ? error : new ConnectionError("UNAVAILABLE");
    const [status, korean, english] = ERRORS[failure.code];
    return json({ code: failure.code, error: request.headers.get("x-site-locale") === "en" ? english : korean }, status,
      failure.retryAfter ? { "Retry-After": String(failure.retryAfter) } : undefined);
  } finally { clearTimeout(timer); }
}

export async function POST(request: Request) { return respond(request, "POST"); }
export async function DELETE(request: Request) { return respond(request, "DELETE"); }
