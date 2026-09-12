import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { boundMaterialPdfWorker } from "./prepare-material-pdf-worker.mjs";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("pdfjs-dist/package.json");
const { version } = JSON.parse(await readFile(packagePath, "utf8"));
const source = await readFile(join(dirname(packagePath), "legacy/build/pdf.worker.mjs"), "utf8");
test("version and source drift fail closed instead of removing allocation bounds", () => {
  assert.throws(() => boundMaterialPdfWorker(source, "999.0.0"), /parser changed/);
  assert.throws(() => boundMaterialPdfWorker(source + "\n", version), /parser changed/);
});
test("server patch covers sync growth and asynchronous decompression retention", () => {
  const patched = boundMaterialPdfWorker(source, version);
  assert.match(patched, /checkMaterialDecodedAllocation\(size\);\n    const buffer2/);
  assert.match(patched, /checkMaterialDecodedAllocation\(chunk.byteLength, totalLength \+ chunk.byteLength\)/);
  assert.match(patched, /checkMaterialDecodedAllocation\(totalLength\);\n      const data/);
  assert.match(patched, /export function assertMaterialDecodeBudget/);
  assert.ok(!source.includes("checkMaterialDecodedAllocation"), "installed package stays unchanged");
});
