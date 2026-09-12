import assert from "node:assert/strict";
import test from "node:test";

import { readMaterialPdfPages } from "./material-pdf.ts";
import { chunkPages } from "./material-text.ts";

// A real, self-contained PDF keeps this test independent of private uploads,
// network requests and mocked PDF.js behavior. Every page has a distinct topic.
function lecturePdf(topics: string[]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${topics.length} /Kids [${topics.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  topics.forEach((topic, i) => {
    const text = `Page ${i + 1}: ${topic}`.replace(/[\\()]/g, "\\$&");
    const stream = `BT /F1 12 Tf 40 740 Td (${text}) Tj ET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    );
  });
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}

test("real PDF.js extracts beginning, middle and final page topics without loss through chunking", async () => {
  const topics = [
    "Introduction to assets", "Stocks", "Bonds", "Money markets", "Mutual funds", "Risk",
    "Eurodollars are US dollar deposits held outside the United States.",
    "Liquidity", "Compound interest", "Bond equivalent yield", "Derivatives", "Portfolio diversification",
  ];
  const bytes = lecturePdf(topics);
  const result = await readMaterialPdfPages(bytes, topics.map((_, i) => i + 1));
  assert.equal(result.pageCount, topics.length);
  assert.equal(result.pages.length, topics.length);
  const indexedText = chunkPages(result.pages).map(chunk => chunk.text).join("\n");
  topics.forEach((topic, i) => {
    assert.ok(result.pages[i].text.includes(topic), `native extraction missed page ${i + 1}`);
    assert.ok(indexedText.includes(topic), `stored chunks missed page ${i + 1}`);
  });
  assert.ok(bytes.byteLength > 0, "PDF reader detached the upload buffer");
});
