import pdfParse from "pdf-parse/lib/pdf-parse.js";

/**
 * Outcome of a PDF text extraction. `no_text_layer` is the scanned/image-only
 * case: the document parsed fine and has pages, but there is no embedded text
 * to extract — indexing it would silently lose the document (see issue #7157).
 */
type PdfExtractionStatus = "ok" | "no_text_layer" | "empty" | "parse_failed";

interface PdfExtractionResult {
  text: string;
  status: PdfExtractionStatus;
  pageCount?: number;
  error?: string;
}

/**
 * Extracts text from a PDF buffer.
 *
 * Uses the internal pdf-parse entrypoint directly to avoid the test-file code
 * that pdf-parse v1 runs at the top level of its public entry point, which
 * fails when executed outside its own repository.
 *
 * Never throws: parse failures (password-protected, malformed/corrupt
 * structure, truncated) come back as `parse_failed` with empty text, so
 * callers can skip the item while still reporting why it was unreadable.
 */
/**
 * Human-readable explanation of why a PDF yielded no text, for skip
 * reporting on the connector run. Returns undefined when extraction
 * succeeded.
 */
export function describePdfEmptyText(
  result: PdfExtractionResult,
): string | undefined {
  switch (result.status) {
    case "ok":
      return undefined;
    case "no_text_layer":
      return `PDF has ${result.pageCount} page(s) but no extractable text layer (likely scanned or image-only)`;
    case "empty":
      return "PDF contains no pages";
    case "parse_failed":
      return `PDF could not be parsed${result.error ? `: ${result.error}` : ""}`;
  }
}

export async function parsePdfBuffer(
  buffer: Buffer,
): Promise<PdfExtractionResult> {
  try {
    const result = await pdfParse(buffer);
    if (result.text.trim()) {
      return { text: result.text, status: "ok", pageCount: result.numpages };
    }
    return {
      text: "",
      status: result.numpages > 0 ? "no_text_layer" : "empty",
      pageCount: result.numpages,
    };
  } catch (error) {
    return {
      text: "",
      status: "parse_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
