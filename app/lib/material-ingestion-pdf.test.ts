import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";

const workers: FakeWorker[] = [];
let assetsAvailable = true;
class FakeWorker extends EventEmitter {
  stdout = { resume() {} }; stderr = { resume() {} };
  terminated = false;
  path: string;
  options: Record<string, unknown>;
  constructor(path: string, options: Record<string, unknown>) {
    super(); this.path = path; this.options = options; workers.push(this);
  }
  async terminate() { this.terminated = true; return 0; }
}
mock.module("node:worker_threads", { namedExports: { Worker: FakeWorker } });
mock.module("node:fs", { namedExports: { existsSync: () => assetsAvailable } });
const { extractBoundedPdf, MATERIAL_PDF_PARSE_TIMEOUT_MS } = await import("./material-ingestion-pdf.ts");
const bytes = new Uint8Array(Buffer.from("%PDF-1.7"));

test("deadline terminates the parser and releases its slot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = assert.rejects(extractBoundedPdf(bytes), /PDF_TIMEOUT/);
  const worker = workers.at(-1)!;
  assert.equal(worker.path, `${process.cwd()}/app/lib/material-pdf-worker.mjs`);
  assert.deepEqual(worker.options.resourceLimits, { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 });
  t.mock.timers.tick(MATERIAL_PDF_PARSE_TIMEOUT_MS);
  await pending;
  assert.equal(worker.terminated, true);
});
test("20 simultaneous parses admit two workers and fail fast for the rest", async () => {
  const before = workers.length;
  const attempts = Array.from({ length: 20 }, () => extractBoundedPdf(bytes));
  const results = Promise.allSettled(attempts);
  assert.equal(workers.length - before, 2);
  for (const worker of workers.slice(before)) worker.emit("message", { result: { pageCount: 1, pages: [] } });
  const settled = await results;
  assert.equal(settled.filter(r => r.status === "fulfilled").length, 2);
  for (const result of settled.filter(r => r.status === "rejected")) assert.match(result.reason.message, /PDF_BUSY/);
  assert.ok(workers.slice(before).every(worker => worker.terminated));
});
test("aborted requests terminate their workers and do not strand capacity", async () => {
  const controller = new AbortController();
  const pending = assert.rejects(extractBoundedPdf(bytes, controller.signal), /PDF_ABORTED/);
  const worker = workers.at(-1)!;
  controller.abort();
  await pending;
  assert.equal(worker.terminated, true);
  const next = extractBoundedPdf(bytes);
  workers.at(-1)!.emit("message", { result: { pageCount: 1, pages: [] } });
  await next;
});
test("worker heap exhaustion returns a controlled resource error and cleans up", async () => {
  const pending = assert.rejects(extractBoundedPdf(bytes), /PDF_RESOURCE_LIMIT/);
  const worker = workers.at(-1)!;
  worker.emit("error", Object.assign(new Error("untrusted native detail"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
  await pending;
  assert.equal(worker.terminated, true);
});
test("missing deployment assets fail as runtime unavailable before spawning a worker", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const before = workers.length;
  assetsAvailable = false;
  try { await assert.rejects(extractBoundedPdf(bytes), /PDF_RUNTIME_UNAVAILABLE/); }
  finally { assetsAvailable = true; }
  assert.equal(workers.length, before);
  assert.deepEqual(log.mock.calls[0].arguments, ["PDF runtime assets unavailable", { entry: false, guard: false, engine: false }]);
});
test("module startup errors expose only whitelisted diagnostics, never paths or raw errors", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const pending = assert.rejects(extractBoundedPdf(bytes), /PDF_RUNTIME_UNAVAILABLE/);
  workers.at(-1)!.emit("error", Object.assign(new Error("Cannot find module /private/secret-path"), { code: "ERR_MODULE_NOT_FOUND" }));
  await pending;
  const output = JSON.stringify(log.mock.calls[0].arguments);
  assert.match(output, /ERR_MODULE_NOT_FOUND/);
  assert.ok(!output.includes("secret-path"));
});
test("missing worker entry and require stack identify only expected path categories", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const pending = assert.rejects(extractBoundedPdf(bytes), /PDF_RUNTIME_UNAVAILABLE/);
  workers.at(-1)!.emit("error", Object.assign(new Error("Cannot find module '/private/secret-path/app/lib/material-pdf-worker.mjs'"), {
    code: "MODULE_NOT_FOUND",
    requireStack: ["/private/secret-path/___next_launcher.cjs", "/private/secret-path/private-document-name.js"],
  }));
  await pending;
  const diagnostic = log.mock.calls[0].arguments[1] as { missingModule: string; requireStack: string[] };
  assert.equal(diagnostic.missingModule, "worker_entry");
  assert.deepEqual(diagnostic.requireStack, ["___next_launcher.cjs", "other"]);
  assert.ok(!JSON.stringify(log.mock.calls[0].arguments).includes("secret-path"));
  assert.ok(!JSON.stringify(log.mock.calls[0].arguments).includes("private-document-name"));
});
test("unexpected worker exit is distinguished from parser rejection", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const pending = assert.rejects(extractBoundedPdf(bytes), /PDF_PARSE_FAILED/);
  workers.at(-1)!.emit("exit", 1);
  await pending;
  assert.deepEqual(log.mock.calls[0].arguments, ["PDF worker exited without a result", { stage: "exit", exitCode: 1 }]);
});
