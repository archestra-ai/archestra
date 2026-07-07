import pdfParse from "pdf-parse/lib/pdf-parse.js";

/**
 * Extracts text from a PDF buffer.
 *
 * Uses the internal pdf-parse entrypoint directly to avoid the test-file code
 * that pdf-parse v1 runs at the top level of its public entry point, which
 * fails when executed outside its own repository.
 *
 * Returns an empty string for password-protected PDFs instead of throwing.
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  try {
    const result = await pdfParse(buffer);
    return result.text;
  } catch {
    // A PDF we cannot parse (password-protected, malformed/corrupt structure, or
    // truncated) has no extractable text. Return empty so the caller skips it,
    // rather than surfacing a hard per-item error for an unreadable source file.
    return "";
  }
}
