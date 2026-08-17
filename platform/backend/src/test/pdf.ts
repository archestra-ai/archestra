/**
 * Build a minimal classic-xref PDF in memory for tests.
 *
 * The production parser is the 2018 pdf.js build pinned inside pdf-parse,
 * which (with `stopAtErrors: true`) rejects the modern object-stream output
 * of contemporary PDF writers — so tests construct the bytes directly:
 * uncompressed content streams, base-14 Helvetica, a hand-computed xref.
 * `null` pages carry no content stream text and classify as textless, the
 * scanned-page shape.
 *
 * Output is padded above 4096 bytes with a comment: the pinned build misreads
 * any buffer at or below that size (its initial-chunk handling), reporting
 * `parse_failed` for byte-identical content that parses fine when larger —
 * the reason the committed scanned fixture is 4148 bytes.
 */
export function makeTestPdf(pages: (string | null)[]): Buffer {
  const objects: string[] = [];
  const pageObjNumbers = pages.map((_, i) => 4 + i * 2);

  // 1: catalog, 2: pages tree, 3: font
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageObjNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  objects.push(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );

  for (const [i, text] of pages.entries()) {
    const contentObj = pageObjNumbers[i] + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
    const stream = text
      ? `BT /F1 12 Tf 40 150 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`
      : "";
    objects.push(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, obj] of objects.entries()) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  if (body.length <= 4200) {
    body += `%${"p".repeat(4200 - body.length)}\n`;
  }
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body + xref + trailer, "latin1");
}
