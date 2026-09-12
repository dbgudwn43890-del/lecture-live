import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { HttpRequest, Upload as TusUpload } from "tus-js-client";
import type { AudioUploadTransfer } from "../lib/lecture-audio-transfer.ts";

type Options = ConstructorParameters<typeof TusUpload>[1];
type Previous = Awaited<ReturnType<TusUpload["findPreviousUploads"]>>[number];
let instances: FakeUpload[] = [];
let history: Previous[] = [];
let historyFails = false;
let abortFails = false;
class FakeUpload {
  file: File;
  options: Options;
  starts = 0;
  aborts = 0;
  historyReads = 0;
  resumed: Previous | null = null;
  constructor(file: File, options: Options) { this.file = file; this.options = options; instances.push(this); }
  start() { this.starts++; }
  abort() { this.aborts++; return abortFails ? Promise.reject(new Error("abort failed")) : Promise.resolve(); }
  findPreviousUploads() { this.historyReads++; return historyFails ? Promise.reject(new Error("storage unavailable")) : Promise.resolve(history); }
  resumeFromPreviousUpload(previous: Previous) { this.resumed = previous; }
  succeed() { this.options.onSuccess?.({ lastResponse: { getStatus: () => 201, getHeader: () => undefined, getBody: () => "", getUnderlyingObject: () => null } }); }
}
mock.module("tus-js-client", { namedExports: { Upload: FakeUpload } });
const { AudioTransferError, transferRecording } = await import("./audio-transfer.ts");
const transfer: AudioUploadTransfer = { endpoint: "https://project.storage.supabase.co/storage/v1/upload/resumable/sign", bucketName: "lecture-audio",
  objectName: "owner-id/upload-id.wav", token: "scoped-upload-token", contentType: "audio/wav" };
const file = new File([new Uint8Array(50)], "lecture.wav", { type: "audio/wav", lastModified: 100 });
const flush = async () => { await setImmediate(); };
const prior = (uploadUrl: string): Previous => ({ uploadUrl, size: file.size, metadata: {}, creationTime: "2026-09-11T00:00:00Z", urlStorageKey: uploadUrl, parallelUploadUrls: null });
const request = (url: string) => ({ getURL: () => url }) as HttpRequest;
test.beforeEach(() => { instances = []; history = []; historyFails = abortFails = false; process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key"; });

test("signed recordings use six-MiB chunks, the scoped signature and the public API routing key", async () => {
  const pending = transferRecording(file, transfer, () => {});
  await flush();
  const upload = instances[0];
  assert.equal(upload.file, file);
  assert.equal(upload.options.endpoint, transfer.endpoint);
  assert.equal(upload.options.chunkSize, 6 * 1024 * 1024);
  assert.deepEqual(upload.options.headers, { apikey: "test-publishable-key", "x-signature": transfer.token });
  assert.ok(!Object.hasOwn(upload.options.headers ?? {}, "authorization"), "no user or service bearer token is sent");
  assert.ok(!Object.hasOwn(upload.options.headers ?? {}, "x-upsert"));
  assert.deepEqual(upload.options.metadata, { bucketName: "lecture-audio", objectName: transfer.objectName, contentType: "audio/wav", cacheControl: "3600" });
  assert.equal(upload.options.uploadDataDuringCreation, true);
  assert.equal(upload.options.removeFingerprintOnSuccess, true);
  assert.equal(upload.starts, 1);
  const fingerprint = await upload.options.fingerprint?.(file, upload.options);
  assert.ok(fingerprint?.includes(transfer.objectName));
  assert.ok(!fingerprint?.includes(transfer.token), "temporary upload credentials must not be stored in resume identity");
  upload.succeed();
  await pending;
});

test("resume history ignores foreign origins and other API paths before choosing the matching upload", async () => {
  history = [prior("https://attacker.test/upload"), prior("not a URL"), prior("https://project.storage.supabase.co/auth/v1/token"), prior(`${transfer.endpoint}/saved-upload`)];
  const pending = transferRecording(file, transfer, () => {});
  await flush();
  assert.equal(instances[0].resumed?.uploadUrl, `${transfer.endpoint}/saved-upload`);
  instances[0].succeed();
  await pending;
});

test("every TUS request checks its destination before a scoped token can be sent", async () => {
  const pending = transferRecording(file, transfer, () => {});
  await flush();
  const before = instances[0].options.onBeforeRequest!;
  for (const url of [transfer.endpoint, `${transfer.endpoint}/created-id`]) assert.doesNotThrow(() => before(request(url)));
  for (const url of ["https://attacker.test/storage/v1/upload/resumable/sign/id", "http://project.storage.supabase.co/storage/v1/upload/resumable/sign/id", "https://project.storage.supabase.co/storage/v1/upload/resumable/id", "https://project.storage.supabase.co/storage/v1/object", `${transfer.endpoint}-other`]) {
    assert.throws(() => before(request(url)), error => error instanceof AudioTransferError && error.code === "failed");
  }
  instances[0].succeed();
  await pending;
});

test("transfer progress is forwarded as a percentage and completion releases the abort listener", async () => {
  const progress: number[] = [];
  const controller = new AbortController();
  const pending = transferRecording(file, transfer, value => progress.push(value), controller.signal);
  await flush();
  instances[0].options.onProgress?.(10, 50);
  instances[0].options.onProgress?.(50, 50);
  instances[0].options.onProgress?.(51, 50);
  assert.deepEqual(progress, [20, 100, 100]);
  instances[0].succeed();
  await pending;
  controller.abort();
  await flush();
  assert.equal(instances[0].aborts, 0);
});

for (const [status, code] of [[401, "expired"], [403, "expired"], [413, "too_large"], [500, "failed"]] as const) {
  test(`HTTP ${status} maps to the bounded ${code} error without exposing response details`, async () => {
    const pending = transferRecording(file, transfer, () => {});
    const rejected = assert.rejects(pending, error => error instanceof AudioTransferError && error.code === code && error.message === code);
    await flush();
    instances[0].options.onError?.(Object.assign(new Error("private upstream response"), { originalResponse: { getStatus: () => status } }));
    await rejected;
  });
}

test("an already-aborted transfer does not inspect resume history or start sending", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transferRecording(file, transfer, () => {}, controller.signal), AudioTransferError);
  assert.equal(instances[0].starts, 0);
  assert.equal(instances[0].historyReads, 0);
  assert.equal(instances[0].aborts, 1);
});

test("aborting a transfer settles it even when the library cannot finish abort cleanup", async () => {
  abortFails = true;
  const controller = new AbortController();
  const pending = transferRecording(file, transfer, () => {}, controller.signal);
  const rejected = assert.rejects(pending, AudioTransferError);
  await flush();
  controller.abort();
  await rejected;
  await flush();
  assert.equal(instances[0].aborts, 1);
});

test("a failed local resume-history lookup does not start an untracked transfer", async () => {
  historyFails = true;
  await assert.rejects(transferRecording(file, transfer, () => {}), AudioTransferError);
  assert.equal(instances[0].starts, 0);
});
