/**
 * A one-page PDF with a single line of text, so seeded "PDF" files are real
 * PDFs that the upload's text extraction can read. Same layout as the
 * backend's test fixture builder: the server's pinned pdf.js misreads a
 * buffer of 4096 bytes or less, so the body is padded with a comment.
 */
export function textPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 40 150 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  if (body.length <= 4200) body += `%${"p".repeat(4200 - body.length)}\n`;
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body + xref + trailer, "latin1");
}
