import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

process.env.DEEPGRAM_API_KEY = "dg-test";
process.env.SITE_URL = "https://lecue.test";
process.env.LECTURE_AUDIO_CALLBACK_SECRET = "test-secret";

const userId = randomUUID();
const sessionId = randomUUID();
const uploadId = randomUUID();
let providerUrls: URL[] = [];
let mutations: string[] = [];
let credits = 180;
let durationMs = 1000;
let providerStatus = 200;
let throwProvider = false;
let settlementCharges: boolean[] = [];
let reservations: number[] = [];
let adminConfigured = true;
let decoderInstalled = true;
let recordingConsents = true;
let authenticated = true;
let verifiedFiles = 0;
let afterCallbacks: (() => Promise<void>)[] = [];
let expiredUploads: { id: string; object_key: string }[] = [];
let cleanupFilters: { operation: string; filters: Record<string, unknown> }[] = [];
let deletionJobs: Record<string, unknown>[] = [];
let drainCalls: Record<string, unknown>[] = [];
let cleanupFailure: "enqueue" | "drain" | null = null;

function queryBuilder(table: string) {
  let operation = "select";
  let columns = "";
  const filters: Record<string, unknown> = {};
  const settle = () => {
    let data: unknown = null;
    if (table === "uploads" && columns === "id,object_key") {
      cleanupFilters.push({ operation, filters });
      data = expiredUploads;
    }
    if (table === "lecture_sessions" && operation === "insert") data = { id: sessionId };
    if (table === "uploads" && operation !== "select") data = { id: uploadId, session_id: sessionId, status: "processing" };
    if (table === "uploads" && operation === "update") cleanupFilters.push({ operation, filters });
    if (table === "classrooms") data = { id: "classroom", glossary: "Fourier transform, Lecue" };
    return Promise.resolve({ data, error: null });
  };
  const api = {
    select(value: string) { columns = value; return api; },
    insert() { operation = "insert"; mutations.push(`${table}.insert`); return api; },
    update() { operation = "update"; mutations.push(`${table}.update`); return api; },
    delete() { operation = "delete"; mutations.push(`${table}.delete`); return api; },
    eq(key: string, value: unknown) { filters[key] = value; return api; },
    is() { return api; },
    lt() { return api; },
    order() { return api; },
    limit() { return api; },
    single: settle,
    maybeSingle: settle,
    then(resolve: (value: { data: unknown; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
      return settle().then(resolve, reject);
    },
  };
  return api;
}

const supabaseStub = {
  auth: { getUser: async () => ({ data: { user: authenticated ? { id: userId, email: "learner@example.com", email_confirmed_at: "2026-09-01" } : null }, error: null }) },
  from: queryBuilder,
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "get_credit_status") return { data: [{ credits }], error: null };
    if (name === "reserve_audio_credits_service") {
      const required = Math.ceil(Number(args.p_duration_ms) / 60000);
      reservations.push(required);
      const allowed = credits >= required;
      if (allowed) credits -= required;
      return { data: [{ credits, allowed }], error: null };
    }
    if (name === "settle_audio_credits_service") settlementCharges.push(Boolean(args.p_charge));
    return { data: true, error: null };
  },
  storage: {
    from: () => ({
      upload: async () => { mutations.push("storage.upload"); return { error: null }; },
      createSignedUrl: async () => ({ data: { signedUrl: "https://storage.example.test/lecture.wav" }, error: null }),
      remove: async () => ({ error: null }),
    }),
  },
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      for (const extension of [".ts", ".js"]) {
        try { return nextResolve(`${specifier}${extension}`, context); } catch { /* try the next one */ }
      }
      throw error;
    }
  },
});

mock.module("next/server.js", { namedExports: {
  NextResponse: Response,
  after: (callback: () => Promise<void>) => { afterCallbacks.push(callback); },
} });
mock.module(pathToFileURL("app/lib/supabase/server.ts").href, {
  namedExports: { createClient: async () => supabaseStub },
});
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, {
  namedExports: { createAdminClient: () => adminConfigured ? supabaseStub : null },
});
mock.module(pathToFileURL("app/lib/rate-limit.ts").href, {
  namedExports: { checkSharedRateLimit: async () => ({ allowed: true }) },
});
mock.module(pathToFileURL("app/lib/consent.ts").href, {
  namedExports: { hasRecordingConsents: async () => recordingConsents },
});

mock.module("node:fs/promises", {
  namedExports: { ...fsPromises, access: async () => { if (!decoderInstalled) throw new Error("ENOENT"); } },
});

mock.module(pathToFileURL("app/lib/verified-audio.ts").href, {
  namedExports: { verifyAudio: async () => { verifiedFiles += 1; return { bytes: new Uint8Array([1, 2, 3]), durationMs }; }, verifyAudioStream: async () => { throw new Error("unused"); }, AudioVerificationError: class extends Error {} },
});
mock.module(pathToFileURL("app/lib/storage-cleanup.ts").href, {
  namedExports: {
    enqueueStorageDeletion: async (_admin: unknown, job: Record<string, unknown>) => {
      deletionJobs.push(job);
      if (cleanupFailure === "enqueue") throw new Error("private cleanup detail");
    },
    drainStorageDeletions: async (_admin: unknown, options: Record<string, unknown>) => {
      drainCalls.push(options);
      if (cleanupFailure === "drain") throw new Error("private cleanup detail");
      return {};
    },
  },
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "api.deepgram.com", "the test must never make a live provider request");
  providerUrls.push(url);
  if (throwProvider) throw new Error("timeout");
  return new Response(JSON.stringify({ request_id: "test-provider-job" }), { status: providerStatus });
}) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

const { GET, POST } = await import("./route.ts");

function uploadRequest(language: string | null, locale = "ko") {
  const form = new FormData();
  form.set("file", new File(["test audio"], "lecture.wav", { type: "audio/wav" }));
  form.set("title", "Lecture");
  form.set("classroomId", randomUUID());
  form.set("idempotencyKey", randomUUID());
  form.set("durationMs", "1000");
  if (language !== null) form.set("language", language);
  return new Request("https://lecue.test/api/lecture-audio", {
    method: "POST", headers: { "X-Site-Locale": locale }, body: form,
  });
}

test.beforeEach(() => {
  providerUrls = []; mutations = []; credits = 180; durationMs = 1000; providerStatus = 200; throwProvider = false; settlementCharges = []; reservations = [];
  adminConfigured = true; decoderInstalled = true; recordingConsents = true; authenticated = true; verifiedFiles = 0;
  afterCallbacks = []; expiredUploads = []; cleanupFilters = []; deletionJobs = []; drainCalls = []; cleanupFailure = null;
  process.env.DEEPGRAM_API_KEY = "dg-test";
  process.env.SITE_URL = "https://lecue.test";
  process.env.LECTURE_AUDIO_CALLBACK_SECRET = "test-secret";
  delete process.env.VERCEL;
});

test("upload readiness is available before a file is selected and contains no service credentials", async () => {
  const response = await GET(new Request("https://lecue.test/api/lecture-audio"));
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response?.json(), {
    uploads: [], availability: { available: true, reason: null, maxFileBytes: 209_715_200 },
  });
  assert.equal(verifiedFiles, 0);
  assert.deepEqual(providerUrls, []);
  assert.deepEqual(mutations, []);
});

test("upload status responds before cleanup and keeps deletions scoped to its owner", async () => {
  expiredUploads = [{ id: uploadId, object_key: `${userId}/expired.flac` }];
  const response = await GET(new Request(`https://lecue.test/api/lecture-audio?sessionId=${sessionId}`));
  assert.equal(response?.status, 200);
  assert.deepEqual((await response?.json()).uploads, []);
  assert.equal(afterCallbacks.length, 1);
  assert.deepEqual(cleanupFilters, []);
  assert.deepEqual(deletionJobs, []);
  assert.deepEqual(drainCalls, []);
  assert.deepEqual(mutations, []);

  await afterCallbacks[0]();
  assert.deepEqual(deletionJobs, [{ bucket: "lecture-audio", objectKey: `${userId}/expired.flac`, userId, reason: "upload_expired" }]);
  assert.deepEqual(cleanupFilters, [
    { operation: "select", filters: { user_id: userId } },
    { operation: "update", filters: { id: uploadId, user_id: userId } },
  ]);
  assert.deepEqual(drainCalls, [{ limit: 20, userId }]);
});

for (const stage of ["enqueue", "drain"] as const) test(`a cleanup ${stage} failure leaves status available and is retried on the next poll`, async t => {
  expiredUploads = [{ id: uploadId, object_key: `${userId}/expired.flac` }];
  cleanupFailure = stage;
  const logged = t.mock.method(console, "error", () => {});
  const response = await GET(new Request("https://lecue.test/api/lecture-audio"));
  assert.equal(response?.status, 200);
  assert.deepEqual((await response?.json()).uploads, []);
  await assert.doesNotReject(afterCallbacks[0]);
  assert.deepEqual(logged.mock.calls.map(call => call.arguments), [["Upload cleanup failed"]]);
  if (stage === "enqueue") assert.deepEqual(mutations, [], "the row stays retryable until its deletion is queued");

  cleanupFailure = null;
  const retry = await GET(new Request("https://lecue.test/api/lecture-audio"));
  assert.equal(retry?.status, 200);
  await afterCallbacks[1]();
  assert.equal(deletionJobs.length, 2);
  assert.deepEqual(deletionJobs[1], deletionJobs[0]);
  assert.deepEqual(drainCalls.at(-1), { limit: 20, userId });
});

for (const missing of ["DEEPGRAM_API_KEY", "SITE_URL", "LECTURE_AUDIO_CALLBACK_SECRET", "admin", "decoder"]) {
  test(`a missing ${missing} disables uploads before accepting any file`, async () => {
    if (missing === "admin") adminConfigured = false;
    else if (missing === "decoder") decoderInstalled = false;
    else delete process.env[missing];
    const response = await GET(new Request("https://lecue.test/api/lecture-audio"));
    assert.equal(response?.status, 200);
    assert.deepEqual((await response?.json()).availability, { available: false, reason: "service_unavailable", maxFileBytes: 209_715_200 });

    // Even a forged request cannot bypass the same pre-selection check. The
    // deliberately invalid body also proves it is not read when unavailable.
    const upload = await POST(new Request("https://lecue.test/api/lecture-audio", { method: "POST", body: "not multipart" }));
    assert.equal(upload?.status, 503);
    const body = await upload?.json();
    assert.equal(body.code, "AUDIO_UPLOAD_UNAVAILABLE");
    assert.match(body.error, /현재 서비스에서/);
    assert.doesNotMatch(JSON.stringify(body), /dg-test|test-secret|lecue\.test|DEEPGRAM|SECRET|ffmpeg/);
    assert.equal(verifiedFiles, 0);
    assert.deepEqual(providerUrls, []);
    assert.deepEqual(mutations, []);
    assert.deepEqual(reservations, []);
  });
}

for (const site of ["bad url", "http://localhost:3000", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://lecue.test/path", "https://lecue.test/?token=secret", "https://user:secret@lecue.test"]) {
  test(`an unusable callback origin ${site} is unavailable`, async () => {
    process.env.SITE_URL = site;
    const response = await GET(new Request("https://lecue.test/api/lecture-audio"));
    assert.equal((await response?.json()).availability.available, false);
    assert.deepEqual(providerUrls, []);
  });
}

test("the file size advertised on Vercel is enforced before decoding or spending credits", async () => {
  process.env.VERCEL = "1";
  const response = await GET(new Request("https://lecue.test/api/lecture-audio"));
  assert.equal((await response?.json()).availability.maxFileBytes, 209_715_200);
  const form = new FormData();
  form.set("file", new File([new Uint8Array(209_715_201)], "lecture.wav", { type: "audio/wav" }));
  form.set("title", "Lecture");
  form.set("idempotencyKey", randomUUID());
  const upload = await POST(new Request("https://lecue.test/api/lecture-audio", { method: "POST", body: form }));
  assert.equal(upload?.status, 413);
  assert.deepEqual(await upload?.json(), { error: "200MB 이하의 파일을 올려 주세요.", code: "AUDIO_UPLOAD_TOO_LARGE", maxFileBytes: 209_715_200 });
  assert.equal(verifiedFiles, 0);
  assert.deepEqual(providerUrls, []);
  assert.deepEqual(mutations, []);
  assert.deepEqual(reservations, []);
});

test("availability remains behind authentication", async () => {
  authenticated = false;
  assert.equal((await GET(new Request("https://lecue.test/api/lecture-audio")))?.status, 401);
  assert.equal((await POST(uploadRequest("en")))?.status, 401);
  assert.equal(verifiedFiles, 0);
  assert.deepEqual(mutations, []);
});

test("service readiness never bypasses recording consent or credit checks", async () => {
  recordingConsents = false;
  assert.equal((await POST(uploadRequest("en")))?.status, 403);
  recordingConsents = true;
  credits = 0;
  assert.equal((await POST(uploadRequest("en")))?.status, 402);
  assert.equal(verifiedFiles, 0);
  assert.deepEqual(providerUrls, []);
  assert.deepEqual(mutations, []);
});

for (const language of ["en", "ko", "es", "ja", "zh", "fr", "de", "pt", "hi"]) {
  test(`a ${language} upload submits the exact selected language to Nova-3`, async () => {
    const response = await POST(uploadRequest(language));
    assert.ok(response);
    assert.equal(response.status, 202);
    assert.equal(providerUrls.length, 1);
    const params = providerUrls[0].searchParams;
    assert.equal(params.get("language"), language);
    assert.equal(params.get("model"), "nova-3");
    assert.deepEqual(params.getAll("keyterm"), ["Fourier transform", "Lecue"]);
    assert.equal(params.get("utterances"), "true");
    assert.equal(new URL(params.get("callback")!).pathname, "/api/lecture-audio/callback");
  });
}

test("an unsupported upload language is rejected before storing or submitting audio", async () => {
  const response = await POST(uploadRequest("unsupported", "en"));
  assert.ok(response);
  assert.equal(response.status, 400);
  assert.deepEqual(providerUrls, []);
  assert.deepEqual(mutations, []);
});

test("uploads without a language use the request locale", async () => {
  for (const locale of ["en", "ko"]) {
    const response = await POST(uploadRequest(null, locale));
    assert.ok(response);
    assert.equal(response.status, 202);
    assert.equal(providerUrls.at(-1)?.searchParams.get("language"), locale);
  }
});

test("Korean-English uploads retain the existing Korean batch fallback", async () => {
  const response = await POST(uploadRequest("multi"));
  assert.ok(response);
  assert.equal(response.status, 202);
  assert.equal(providerUrls[0].searchParams.get("language"), "ko");
});

test("the existing default mode does not add model or vocabulary options", async () => {
  const response = await POST(uploadRequest("default"));
  assert.ok(response);
  assert.equal(response.status, 202);
  assert.equal(providerUrls[0].searchParams.get("language"), null);
  assert.equal(providerUrls[0].searchParams.get("model"), null);
  assert.equal(providerUrls[0].searchParams.get("keyterm"), null);
});


test("180-second audio claiming one second cannot submit with one credit", async () => {
  durationMs = 180_000; credits = 1;
  const response = await POST(uploadRequest("en"));
  assert.equal(response?.status, 402);
  assert.deepEqual(reservations, [3]);
  assert.equal(providerUrls.length, 0);
  assert.equal(mutations.includes("storage.upload"), false);
});

test("parallel uploads cannot reuse the same reserved credits", async () => {
  durationMs = 180_000; credits = 3;
  const results = await Promise.all([POST(uploadRequest("en")), POST(uploadRequest("en"))]);
  assert.deepEqual(results.map(r => r?.status).sort(), [202, 402]);
  assert.equal(providerUrls.length, 1);
});

test("definite provider rejection releases the reservation", async () => {
  providerStatus = 400;
  assert.equal((await POST(uploadRequest("en")))?.status, 502);
  assert.deepEqual(settlementCharges, [false]);
});

test("unknown provider acceptance retains the reservation and callback tracking", async () => {
  throwProvider = true;
  assert.equal((await POST(uploadRequest("en")))?.status, 202);
  assert.deepEqual(settlementCharges, []);
  assert.equal(mutations.includes("lecture_sessions.delete"), false);
});
