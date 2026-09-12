import { join } from "node:path";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { MAX_MATERIAL_CHARACTERS, MAX_MATERIAL_TOKEN_BOUND } from "./material-ingestion-budget.ts";
import type { MaterialPage } from "./material-text.ts";

export const MATERIAL_PDF_PARSE_TIMEOUT_MS = 30_000;
const MAX_ACTIVE_PDF_PARSERS = 2;
let activeParsers = 0;

function missingModuleCategory(value: unknown) {
  if (typeof value !== "string") return "unknown";
  if (value.endsWith("/material-pdf-worker.mjs")) return "worker_entry";
  if (value.endsWith("/material-pdf.worker.mjs")) return "bounded_worker";
  if (value.endsWith("/pdfjs-dist/legacy/build/pdf.mjs")) return "pdf_engine";
  if (/material-pdf-worker_mjs_[^/\\]*\.js$/.test(value)) return "turbopack_worker_entry";
  if (value.endsWith("/[turbopack]_runtime.js")) return "turbopack_runtime";
  if (/\[root-of-the-server\]__[^/\\]*\.js$/.test(value)) return "turbopack_server_chunk";
  if (value === "@napi-rs/canvas") return "optional_canvas";
  if (["node:worker_threads", "worker_threads", "node:fs", "fs", "node:module", "module", "node:path", "path", "node:url", "url"].includes(value)) return "node_builtin";
  return "other";
}

function workerFailure(error: unknown, stage: "constructor" | "worker") {
  const rawCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const knownCodes = ["ERR_WORKER_OUT_OF_MEMORY", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ENOENT", "ERR_WORKER_INIT_FAILED", "ERR_WORKER_INVALID_EXEC_ARGV"];
  const code = typeof rawCode === "string" && knownCodes.includes(rawCode) ? rawCode : "UNKNOWN";
  const rawName = error && typeof error === "object" && "name" in error ? error.name : undefined;
  const name = typeof rawName === "string" && ["Error", "ReferenceError", "TypeError", "SyntaxError", "RangeError"].includes(rawName) ? rawName : "UnknownError";
  const rawMessage = error && typeof error === "object" && "message" in error ? error.message : undefined;
  const symbol = name === "ReferenceError"
    ? ["DOMMatrix", "Path2D", "ReadableStream", "Buffer", "navigator"].find(value => rawMessage === `${value} is not defined`) ?? null : null;
  const inheritedPreload = /(?:^|\s)--(?:require|import)(?:=|\s)/.test(process.env.NODE_OPTIONS ?? "");
  const missing = typeof rawMessage === "string" ? /^Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(rawMessage)?.[1] : undefined;
  const missingModule = ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(code) ? missingModuleCategory(missing) : null;
  const rawStack = error && typeof error === "object" && "requireStack" in error ? error.requireStack : undefined;
  const requireStack = Array.isArray(rawStack) ? rawStack.slice(0, 5).map(value => {
    const category = missingModuleCategory(value);
    if (category !== "other" && category !== "unknown") return category;
    const filename = typeof value === "string" ? value.split(/[\\/]/).at(-1) : undefined;
    return ["___next_launcher.cjs", "___vc_handler.cjs", "bootstrap.js", "index.js"].includes(filename ?? "") ? filename : "other";
  }) : [];
  console.error("PDF worker startup failed", { stage, code, name, symbol, inheritedPreload, missingModule, requireStack });
  return new Error(code === "ERR_WORKER_OUT_OF_MEMORY" ? "PDF_RESOURCE_LIMIT"
    : symbol || ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ENOENT", "ERR_WORKER_INIT_FAILED", "ERR_WORKER_INVALID_EXEC_ARGV"].includes(code)
      ? "PDF_RUNTIME_UNAVAILABLE" : "PDF_PARSE_FAILED");
}

/** Isolate PDF.js CPU/JS-heap work; a parent timer can terminate a stuck parser. */
export async function extractBoundedPdf(bytes: Uint8Array, signal?: AbortSignal): Promise<{
  pageCount: number; pages: MaterialPage[];
}> {
  if (signal?.aborted) throw new Error("PDF_ABORTED");
  if (!bytes.byteLength || bytes.byteLength > 20_000_000) throw new Error("PDF_INPUT_LIMIT");
  if (activeParsers >= MAX_ACTIVE_PDF_PARSERS) throw new Error("PDF_BUSY");
  const assets = {
    entry: existsSync(join(process.cwd(), "app/lib/material-pdf-worker.mjs")),
    guard: existsSync(join(process.cwd(), ".pdfjs/material-pdf.worker.mjs")),
    engine: existsSync(join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.mjs")),
  };
  if (!assets.entry || !assets.guard || !assets.engine) {
    console.error("PDF runtime assets unavailable", assets);
    throw new Error("PDF_RUNTIME_UNAVAILABLE");
  }
  activeParsers++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    try {
      // Next 16.3.3 rewrites `new Worker(path, options)` into a Turbopack
      // entry that fails at startup with MODULE_NOT_FOUND. Keep this Node
      // worker on the explicitly traced native file, outside that transform.
      worker = Reflect.construct(Worker, [join(process.cwd(), "app/lib/material-pdf-worker.mjs"), {
        workerData: { bytes, maxCharacters: MAX_MATERIAL_CHARACTERS, maxTokenBound: MAX_MATERIAL_TOKEN_BOUND },
        // Do not inherit test loaders, inspectors or unrelated CLI switches.
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        // Parser warnings can include untrusted document contents.
        stdout: true,
        stderr: true,
      }]) as Worker;
    } catch (error) { throw workerFailure(error, "constructor"); }
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => { settled = true; reject(error); };
      timer = setTimeout(() => fail(new Error("PDF_TIMEOUT")), MATERIAL_PDF_PARSE_TIMEOUT_MS);
      abort = () => fail(new Error("PDF_ABORTED"));
      signal?.addEventListener("abort", abort, { once: true });
      worker!.once("message", (message) => {
        if (settled) return;
        if (message?.error) {
          const code = ["PDF_PAGE_LIMIT", "MATERIAL_TEXT_LIMIT", "PDF_RESOURCE_LIMIT", "PDF_PARSE_FAILED"].includes(message.error) ? message.error : "PDF_PARSE_FAILED";
          if (code === "PDF_PARSE_FAILED") console.error("PDF worker parse failed", { stage: "parser", code });
          fail(new Error(code));
        } else if (message?.result && Array.isArray(message.result.pages)) {
          settled = true; resolve(message.result);
        } else {
          console.error("PDF worker returned invalid result", { stage: "message" });
          fail(new Error("PDF_PARSE_FAILED"));
        }
      });
      worker!.once("error", (error) => { if (!settled) fail(workerFailure(error, "worker")); });
      worker!.once("exit", (exitCode) => {
        if (settled) return;
        console.error("PDF worker exited without a result", { stage: "exit", exitCode: Number.isSafeInteger(exitCode) ? exitCode : null });
        fail(new Error("PDF_PARSE_FAILED"));
      });
      if (signal?.aborted) abort();
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    // Await termination before freeing the local parser slot, including success.
    try { await worker?.terminate(); } finally { activeParsers--; }
  }
}
