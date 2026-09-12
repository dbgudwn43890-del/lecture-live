import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packagePath = require.resolve("pdfjs-dist/package.json");
const { version } = JSON.parse(await readFile(packagePath, "utf8"));

test("prepares the exact installed legacy worker and is safe to repeat", async () => {
  const source = await readFile(join(dirname(packagePath), "legacy/build/pdf.worker.min.mjs"));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    execFileSync(process.execPath, [join(root, "build-tools/prepare-pdf-worker.mjs")]);
    const worker = await readFile(join(root, "public/pdfjs", version, "pdf.worker.min.mjs"));
    assert.deepEqual(worker, source);
  }
});

test("both development and deployment prepare the worker without replacing audio setup", async () => {
  const { scripts } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(scripts.predev, "node build-tools/prepare-pdf-worker.mjs");
  assert.equal(scripts.prebuild, scripts.predev);
  assert.equal(scripts.postinstall, "node build-tools/install-audio-ffmpeg.mjs");
});
