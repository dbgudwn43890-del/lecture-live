import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

type Row = Record<string, any>;
const userId = randomUUID();
let uploads = new Map<string, Row>();
let sessions = new Map<string, Row>();
let reservations = new Map<string, Row>();
let signedPaths: string[] = [];
let storedPaths: string[] = [];
let deletedPaths: string[] = [];
let providerRequests: Array<{ url: URL; body: Row }> = [];
let credits = 180;
let durationMs = 180_000;
let sourceBytes = 5 * 1024 * 1024;
let verified = 0;
let sourceExists = true;
let providerStatus = 200;
let providerThrows = false;
let authenticated = true;
let consent = true;
let verificationError: string | null = null;

class AudioVerificationError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }
function query(table: string) {
  let filters: Array<[string, unknown]> = [];
  let changes: Row | null = null;
  const finish = async () => {
    const source = table === "uploads" ? uploads : table === "lecture_sessions" ? sessions : table === "audio_credit_reservations" ? reservations : new Map();
    const row = [...source.values()].find(candidate => filters.every(([key, value]) => candidate[key] === value));
    if (row && changes) {
      if (changes.object_key && changes.object_key !== row.object_key && row.object_key) deletedPaths.push(row.object_key);
      Object.assign(row, changes);
    }
    return { data: row ? { ...row } : null, error: null };
  };
  const api = {
    select() { return api; }, eq(key: string, value: unknown) { filters.push([key, value]); return api; },
    update(value: Row) { changes = value; return api; }, maybeSingle: finish,
    then(resolve: (value: Row) => unknown, reject?: (reason: unknown) => unknown) { return finish().then(resolve, reject); },
  };
  return api;
}
const db = {
  auth: { getUser: async () => ({ data: { user: authenticated ? { id: userId, email: "learner@example.test", email_confirmed_at: "2026-09-01" } : null }, error: null }) },
  from: query,
  rpc: async (name: string, args: Row = {}) => {
    if (name === "get_credit_status") return { data: [{ credits }], error: null };
    if (name === "prepare_audio_upload_service") {
      const existing = [...uploads.values()].find(row => row.user_id === args.p_user_id && row.idempotency_key === args.p_idempotency_key);
      if (existing) return { data: { upload: { ...existing }, session: { ...sessions.get(existing.session_id) }, duplicate: true }, error: null };
      const session = { id: randomUUID(), user_id: args.p_user_id, classroom_id: args.p_classroom_id, title: args.p_title, status: "paused", started_at: new Date().toISOString(), ended_at: null, duration_seconds: 0 };
      const id = randomUUID();
      const upload = { id, user_id: args.p_user_id, session_id: session.id, idempotency_key: args.p_idempotency_key, object_key: `${args.p_user_id}/${id}.source`, status: "uploading", filename: args.p_filename, byte_size: args.p_byte_size, source_byte_size: args.p_byte_size, transcription_language: args.p_language, duration_ms: null, error_code: null, created_at: new Date().toISOString(), delete_at: new Date(Date.now() + 86_400_000).toISOString() };
      uploads.set(id, upload); sessions.set(session.id, session);
      return { data: { upload: { ...upload }, session: { ...session } }, error: null };
    }
    if (name === "claim_audio_verification_service") {
      const upload = uploads.get(args.p_upload_id);
      const allowed = Boolean(upload && upload.user_id === args.p_user_id && !upload.verification_token && upload.status === "uploading");
      if (allowed) upload!.verification_token = args.p_token;
      return { data: allowed, error: null };
    }
    if (name === "reserve_audio_credits_service") {
      let reservation = reservations.get(args.p_upload_id);
      const required = Math.ceil(args.p_duration_ms / 60_000);
      if (!reservation && credits >= required) {
        credits -= required;
        reservation = { upload_id: args.p_upload_id, user_id: args.p_user_id, status: "reserved", durationMs: args.p_duration_ms, required };
        reservations.set(args.p_upload_id, reservation);
      }
      return { data: [{ allowed: Boolean(reservation), credits }], error: null };
    }
    if (name === "submit_audio_reservation_service") {
      const row = reservations.get(args.p_upload_id);
      const allowed = row?.status === "reserved";
      if (allowed) row!.status = "submitted";
      return { data: allowed, error: null };
    }
    if (name === "settle_audio_credits_service") {
      const row = reservations.get(args.p_upload_id);
      if (row && !args.p_charge && row.status !== "released") { credits += row.required; row.status = "released"; }
      return { data: 0, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  },
  storage: { from: () => ({
    exists: async () => ({ data: sourceExists, error: null }),
    createSignedUploadUrl: async (path: string, options: Row) => {
      assert.equal(options.upsert, false); signedPaths.push(path);
      return { data: { token: "signed-test-token", path }, error: null };
    },
    createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.example.test/${path}` }, error: null }),
    upload: async (path: string, bytes: Uint8Array, options: Row) => {
      assert.equal(options.contentType, "audio/flac"); assert.equal(bytes.byteLength, 3); storedPaths.push(path);
      return { error: null };
    },
  }) },
};

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    for (const extension of [".ts", ".js"]) { try { return nextResolve(`${specifier}${extension}`, context); } catch {} }
    throw error;
  }
} });
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, { namedExports: { createClient: async () => db } });
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => db } });
mock.module(pathToFileURL("app/lib/rate-limit.ts").href, { namedExports: { checkSharedRateLimit: async () => ({ allowed: true }) } });
mock.module(pathToFileURL("app/lib/consent.ts").href, { namedExports: { hasRecordingConsents: async () => consent } });
mock.module("node:fs/promises", { namedExports: { ...fsPromises, access: async () => {} } });
mock.module(pathToFileURL("app/lib/verified-audio.ts").href, { namedExports: {
  AudioVerificationError,
  verifyAudio: async () => { throw new Error("Direct uploads must not parse a multipart File"); },
  verifyAudioStream: async (stream: ReadableStream<Uint8Array>, expectedBytes: number) => {
    verified++;
    if (verificationError) { await stream.cancel(); throw new AudioVerificationError(verificationError); }
    const actual = (await new Response(stream).arrayBuffer()).byteLength;
    assert.equal(actual, expectedBytes);
    return { bytes: new Uint8Array([1, 2, 3]), durationMs };
  },
} });
mock.module(pathToFileURL("app/lib/storage-cleanup.ts").href, { namedExports: {
  enqueueStorageDeletion: async (_admin: unknown, job: Row) => { deletedPaths.push(job.objectKey); }, drainStorageDeletions: async () => ({}),
} });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "storage.example.test") return new Response(sourceExists ? new Uint8Array(sourceBytes) : null, { status: sourceExists ? 200 : 404 });
  assert.equal(url.hostname, "api.deepgram.com", "the test never contacts a real provider");
  providerRequests.push({ url, body: JSON.parse(String(init?.body)) });
  if (providerThrows) throw new Error("timeout");
  return new Response(JSON.stringify({ request_id: "provider-test-job" }), { status: providerStatus });
}) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });
const { POST } = await import("./route.ts");

function request(body: Row) { return new Request("https://lecue.test/api/lecture-audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
async function prepare(overrides: Row = {}) {
  const response = await POST(request({ action: "prepare", filename: "lecture.wav", byteSize: sourceBytes, title: "My lecture", language: "en", idempotencyKey: randomUUID(), ...overrides }));
  return { response, body: await response!.json() };
}
test.beforeEach(() => {
  uploads = new Map(); sessions = new Map(); reservations = new Map(); signedPaths = []; storedPaths = []; deletedPaths = []; providerRequests = [];
  credits = 180; durationMs = 180_000; sourceBytes = 5 * 1024 * 1024; verified = 0; sourceExists = true; providerStatus = 200; providerThrows = false; authenticated = true; consent = true; verificationError = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.DEEPGRAM_API_KEY = "dg-test"; process.env.SITE_URL = "https://lecue.test"; process.env.LECTURE_AUDIO_CALLBACK_SECRET = "callback-test-secret";
});

test("a >4.5MB recording uses private signed storage and JSON metadata, preserving the lecture title", async () => {
  const { response, body } = await prepare();
  assert.equal(response?.status, 200);
  assert.equal(body.session.title, "My lecture"); assert.equal(body.session.status, "paused");
  assert.equal(body.transfer.endpoint, "https://project.storage.supabase.co/storage/v1/upload/resumable/sign");
  assert.equal(body.transfer.bucketName, "lecture-audio"); assert.equal(body.transfer.contentType, "audio/wav");
  assert.equal(body.transfer.objectName, `${userId}/${body.upload.id}.source`);
  assert.equal(body.availability.maxFileBytes, 209_715_200);
  assert.equal(body.upload.object_key, undefined); assert.equal(body.session.user_id, undefined);
  assert.equal(verified, 0); assert.equal(providerRequests.length, 0);
});
test("long Unicode filenames retain their supported extension", async () => {
  const { response, body } = await prepare({ filename: `${"긴 강의 이름 ".repeat(80)}.wav` });
  assert.equal(response?.status, 200); assert.equal(body.upload.filename.length, 200); assert.ok(body.upload.filename.endsWith(".wav"));
});
test("oversized metadata is rejected before authorizing storage", async () => {
  const { response } = await prepare({ byteSize: 209_715_201 });
  assert.equal(response?.status, 413); assert.equal(signedPaths.length, 0); assert.equal(uploads.size, 0);
});
test("complete decodes the stored object, reserves its measured minutes, and sends only canonical audio", async () => {
  const { body } = await prepare();
  const response = await POST(request({ action: "complete", uploadId: body.upload.id, durationMs: 1, url: "https://attacker.test/audio", objectKey: "another-user/source" }));
  assert.equal(response?.status, 202); assert.equal((await response?.json()).upload.status, "processing");
  assert.equal(verified, 1); assert.equal(credits, 177); assert.equal(reservations.get(body.upload.id)?.durationMs, 180_000);
  assert.equal(providerRequests.length, 1); assert.ok(providerRequests[0].body.url.endsWith(`${body.upload.id}.flac`));
  assert.equal(providerRequests[0].url.searchParams.get("language"), "en");
  assert.ok(deletedPaths.includes(body.transfer.objectName));
  assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id })))?.status, 202);
  assert.equal(verified, 1); assert.equal(providerRequests.length, 1); assert.equal(credits, 177);
});
test("concurrent complete requests acquire one verification lease and provider reservation", async () => {
  const { body } = await prepare();
  const results = await Promise.all([POST(request({ action: "complete", uploadId: body.upload.id })), POST(request({ action: "complete", uploadId: body.upload.id }))]);
  assert.deepEqual(results.map(result => result?.status), [202, 202]); assert.equal(verified, 1); assert.equal(providerRequests.length, 1); assert.equal(credits, 177);
});
test("foreign and arbitrary upload IDs never fetch or decode storage", async () => {
  const { body } = await prepare(); uploads.get(body.upload.id)!.user_id = randomUUID();
  assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id })))?.status, 404);
  assert.equal((await POST(request({ action: "complete", uploadId: "https://attacker.test/audio" })))?.status, 400);
  assert.equal(verified, 0); assert.equal(providerRequests.length, 0);
});
test("auth and consent gates apply before allocating a direct storage token", async () => {
  authenticated = false; assert.equal((await prepare()).response?.status, 401);
  authenticated = true; consent = false; assert.equal((await prepare()).response?.status, 403);
  consent = true; credits = 0; assert.equal((await prepare()).response?.status, 402);
  assert.equal(signedPaths.length, 0); assert.equal(uploads.size, 0);
});
test("a claimed one-second recording still needs credits for all measured minutes", async () => {
  credits = 1; const { body } = await prepare();
  assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id, durationMs: 1 })))?.status, 402);
  assert.equal(credits, 1); assert.equal(providerRequests.length, 0); assert.equal(storedPaths.length, 0);
  assert.equal(uploads.get(body.upload.id)?.verification_token, null);
});
test("an incomplete source releases the lease for a resumable transfer retry", async () => {
  const { body } = await prepare(); sourceExists = false;
  assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id })))?.status, 409);
  assert.equal(verified, 0); assert.equal(uploads.get(body.upload.id)?.verification_token, null);
  sourceExists = true;
  assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id })))?.status, 202);
});
test("invalid audio is discarded without calling or charging a provider", async () => {
  const { body } = await prepare(); verificationError = "invalid";
  assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id })))?.status, 400);
  assert.equal(uploads.get(body.upload.id)?.status, "failed"); assert.equal(credits, 180); assert.equal(providerRequests.length, 0);
  assert.ok(deletedPaths.includes(body.transfer.objectName));
});
test("a busy decoder releases the lease so a later request can run", async () => {
  const { body } = await prepare(); verificationError = "busy";
  assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id })))?.status, 503);
  assert.equal(uploads.get(body.upload.id)?.verification_token, null);
  verificationError = null; assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id })))?.status, 202);
});
test("a verified canonical object resumes after a crash even when all credits are reserved", async () => {
  const { body } = await prepare(); const upload = uploads.get(body.upload.id)!;
  upload.duration_ms = 180_000; upload.object_key = `${userId}/${upload.id}.flac`;
  reservations.set(upload.id, { user_id: userId, upload_id: upload.id, status: "reserved", durationMs: 180_000, required: 3 }); credits = 0;
  assert.equal((await POST(request({ action: "complete", uploadId: upload.id })))?.status, 202);
  assert.equal(verified, 0); assert.equal(providerRequests.length, 1); assert.equal(credits, 0);
});
test("same-file prepare retries skip an already transferred source even if the wallet is now reserved", async () => {
  const idempotencyKey = randomUUID(); const first = await prepare({ idempotencyKey }); credits = 0;
  const retry = await prepare({ idempotencyKey });
  assert.equal(retry.response?.status, 200); assert.equal(retry.body.readyToComplete, true);
  assert.equal(retry.body.transfer, undefined); assert.equal(retry.body.upload.id, first.body.upload.id);
  assert.equal(signedPaths.length, 1);
});
test("unknown provider acceptance retains the reservation and never resubmits", async () => {
  const { body } = await prepare(); providerThrows = true;
  assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id })))?.status, 202);
  assert.equal(reservations.get(body.upload.id)?.status, "submitted");
  assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id })))?.status, 202);
  assert.equal(providerRequests.length, 1); assert.equal(credits, 177);
});
test("definite provider rejection releases credits and marks the upload failed", async () => {
  const { body } = await prepare(); providerStatus = 400;
  assert.equal((await POST(request({ action: "complete", uploadId: body.upload.id })))?.status, 502);
  assert.equal(uploads.get(body.upload.id)?.status, "failed"); assert.equal(reservations.get(body.upload.id)?.status, "released"); assert.equal(credits, 180);
});
