import { Readable } from "node:stream";
import { createDeflate, deflateSync } from "node:zlib";

// Self-contained compressed native PDFs: no private files, network or paid API.
export function compressedPdf(topics: string[]) {
  return pdfFromStreams(topics.map(topic => deflateSync(Buffer.from(
    `BT /F1 1 Tf 0 740 Td (${topic.replace(/[\\()]/g, "\\$&")}) Tj ET\n`,
  ))));
}

/** Generate a large decoded comment using only a small reusable source buffer. */
export async function compressedCommentPdf(commentBytes: number, pages = 1) {
  const block = Buffer.alloc(16_384, "x");
  async function* content() {
    yield Buffer.from("%");
    for (let remaining = commentBytes; remaining > 0; remaining -= block.length) yield block.subarray(0, Math.min(remaining, block.length));
    yield Buffer.from("\nBT /F1 1 Tf 0 740 Td (Small readable lecture text) Tj ET\n");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(content()).pipe(createDeflate())) chunks.push(chunk);
  const stream = Buffer.concat(chunks);
  return pdfFromStreams(Array.from({ length: pages }, () => stream));
}

function pdfFromStreams(streams: Buffer[]) {
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(`<< /Type /Pages /Count ${streams.length} /Kids [${streams.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  streams.forEach((stream, i) => {
    objects.push(
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000000 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`),
      Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]),
    );
  });
  let pdf = Buffer.from("%PDF-1.7\n");
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf = Buffer.concat([pdf, Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
  });
  const xref = pdf.length;
  return new Uint8Array(Buffer.concat([pdf, Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]));
}
