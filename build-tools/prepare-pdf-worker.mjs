import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareMaterialPdfWorker } from "./prepare-material-pdf-worker.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await prepareMaterialPdfWorker();
const require = createRequire(import.meta.url);
const packagePath = require.resolve("pdfjs-dist/package.json");
const { version } = JSON.parse(await readFile(packagePath, "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Unsupported PDF.js version: ${version}`);
}

// Keep the legacy API and worker on the exact same installed version. Serving
// the worker as a static module avoids bundler-specific ESM URL resolution.
const destination = join(root, "public", "pdfjs", version);
await mkdir(destination, { recursive: true });
await copyFile(
  join(dirname(packagePath), "legacy", "build", "pdf.worker.min.mjs"),
  join(destination, "pdf.worker.min.mjs"),
);
console.log(`PDF.js worker ${version} is ready.`);
