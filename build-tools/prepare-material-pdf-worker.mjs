import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "6.3.289";
const SOURCE_SHA256 = "df3bf6bf6b8b8dac8a4042d8c4ecf1cf21e1d197e0fe231c192122409eba656b";

/** Server-ingestion-only patch. A PDF.js upgrade requires reviewing these bounds. */
export function boundMaterialPdfWorker(source, version) {
  if (version !== VERSION || createHash("sha256").update(source).digest("hex") !== SOURCE_SHA256) {
    throw new Error("PDF.js material parser changed; review decoded-stream limits before rebuilding");
  }
  const replaceOnce = (before, after) => {
    if (source.split(before).length !== 2) throw new Error("PDF.js decoded-stream patch anchor changed");
    source = source.replace(before, after);
  };
  replaceOnce("class DecodeStream extends BaseStream {", `
// Lecue server ingestion: external typed-array allocations are not covered by
// worker_threads.resourceLimits. Count capacity before each decode allocation,
// including replaced buffers, to bound total allocation churn per document.
let materialDecodedAllocations = 0;
let materialDecodeLimitExceeded = false;
function checkMaterialDecodedAllocation(bytes, streamBytes = bytes) {
  if (materialDecodeLimitExceeded || !Number.isSafeInteger(bytes) || bytes < 0 ||
      streamBytes > 32 * 1024 * 1024 || materialDecodedAllocations + bytes > 128 * 1024 * 1024) {
    materialDecodeLimitExceeded = true;
    throw new Error("PDF_RESOURCE_LIMIT");
  }
  materialDecodedAllocations += bytes;
}
export function assertMaterialDecodeBudget() {
  if (materialDecodeLimitExceeded) throw new Error("PDF_RESOURCE_LIMIT");
}
class DecodeStream extends BaseStream {`);
  replaceOnce("    const buffer2 = new Uint8Array(size);\n    buffer2.set(buffer);", 
    "    checkMaterialDecodedAllocation(size);\n    const buffer2 = new Uint8Array(size);\n    buffer2.set(buffer);");
  replaceOnce("      for await (const chunk of readable) {\n        chunks.push(chunk);\n        totalLength += chunk.byteLength;\n      }\n      const data = new Uint8Array(totalLength);", 
    "      for await (const chunk of readable) {\n        checkMaterialDecodedAllocation(chunk.byteLength, totalLength + chunk.byteLength);\n        chunks.push(chunk);\n        totalLength += chunk.byteLength;\n      }\n      checkMaterialDecodedAllocation(totalLength);\n      const data = new Uint8Array(totalLength);");
  return source;
}

export async function prepareMaterialPdfWorker() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("pdfjs-dist/package.json");
  const { version } = JSON.parse(await readFile(packagePath, "utf8"));
  const source = await readFile(join(dirname(packagePath), "legacy/build/pdf.worker.mjs"), "utf8");
  const bounded = boundMaterialPdfWorker(source, version);
  const destination = join(root, ".pdfjs");
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "material-pdf.worker.mjs"), bounded);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareMaterialPdfWorker();
  console.log("Bounded server PDF.js worker is ready.");
}
