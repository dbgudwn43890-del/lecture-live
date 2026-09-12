import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { compressedCommentPdf, compressedPdf } from "../app/lib/material-pdf-fixture.ts";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const run = promisify(execFile);

// Plain TypeScript tests cannot catch Turbopack rewriting native Worker paths.
// Build and execute a real, isolated route; no server, network or provider calls.
test("compiled Next route preserves the native PDF worker and decoding limits", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lecue-pdf-bundle-"));
  const previousCwd = process.cwd();
  try {
    for (const file of ["app/lib/material-ingestion-pdf.ts", "app/lib/material-ingestion-budget.ts", "app/lib/material-text.ts", "app/lib/material-pdf-worker.mjs", ".pdfjs/material-pdf.worker.mjs"]) {
      await mkdir(dirname(join(fixture, file)), { recursive: true });
      await copyFile(join(project, file), join(fixture, file));
    }
    await symlink(join(project, "node_modules"), join(fixture, "node_modules"), "junction");
    await copyFile(join(project, "package.json"), join(fixture, "package.json"));
    await copyFile(join(project, "tsconfig.json"), join(fixture, "tsconfig.json"));
    await writeFile(join(fixture, "next.config.mjs"), `export default ${JSON.stringify({
      turbopack: { root: parse(fixture).root }, serverExternalPackages: ["pdfjs-dist"],
      outputFileTracingIncludes: { "/api/materials": ["./app/lib/material-pdf-worker.mjs", "./.pdfjs/material-pdf.worker.mjs", "./node_modules/pdfjs-dist/legacy/build/pdf.mjs"] },
    })};`);
    await writeFile(join(fixture, "normal.pdf"), compressedPdf(["Synthetic page 1.", "Synthetic page 2."]));
    await writeFile(join(fixture, "expanded.pdf"), await compressedCommentPdf(40 * 1024 * 1024));
    await mkdir(join(fixture, "app/api/materials"), { recursive: true });
    await writeFile(join(fixture, "app/api/materials/route.ts"), `
      import {readFile} from 'node:fs/promises';
      import {join} from 'node:path';
      import {extractBoundedPdf} from '../../lib/material-ingestion-pdf';
      export const runtime='nodejs'; export const dynamic='force-dynamic';
      export async function GET(request: Request) {
        const name=new URL(request.url).searchParams.has('expanded')?'expanded.pdf':'normal.pdf';
        try { const value=await extractBoundedPdf(new Uint8Array(await readFile(join(process.cwd(),name))));
          return Response.json({pageCount:value.pageCount,textPages:value.pages.length});
        } catch(error) {return Response.json({error:error instanceof Error?error.message:'unknown'});}
      }
    `);
    await run(process.execPath, [require.resolve("next/dist/bin/next"), "build"], {
      cwd: fixture, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, timeout: 60_000, maxBuffer: 1_000_000,
    });
    const trace = JSON.parse(await readFile(join(fixture, ".next/server/app/api/materials/route.js.nft.json"), "utf8"));
    assert.ok(trace.files.some(file => file.endsWith("app/lib/material-pdf-worker.mjs")));
    assert.ok(!trace.files.some(file => /material-pdf-worker_mjs_.*\.js$/.test(file)), "Turbopack replaced the native worker entry");
    process.chdir(fixture);
    const { routeModule } = require(join(fixture, ".next/server/app/api/materials/route.js"));
    assert.deepEqual(await (await routeModule.userland.GET(new Request("https://fixture.invalid/api/materials"))).json(), { pageCount: 2, textPages: 2 });
    assert.deepEqual(await (await routeModule.userland.GET(new Request("https://fixture.invalid/api/materials?expanded"))).json(), { error: "PDF_RESOURCE_LIMIT" });
  } finally {
    process.chdir(previousCwd);
    await rm(fixture, { recursive: true, force: true });
  }
});
