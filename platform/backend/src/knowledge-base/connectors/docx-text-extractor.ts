import mammoth from "mammoth";

export async function extractTextFromDocx(buffer: Buffer): Promise<string> {
  try {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  } catch (err) {
    // A file whose extension/mimetype claims an OOXML type but whose bytes are
    // not a valid ZIP (a mislabeled legacy binary .doc, an HTML error page, or a
    // truncated download) has no extractable text. Treat it as empty so the
    // caller skips it, rather than surfacing a hard per-item error.
    if (isCorruptOfficeFileError(err)) return "";
    throw err;
  }
}

/**
 * OOXML files (.docx, .pptx, .xlsx) are ZIP containers. When the bytes are not a
 * valid ZIP the reader (JSZip, directly or via mammoth) throws "Can't find end of
 * central directory". Callers use this to treat such files as having no
 * extractable text instead of a hard failure.
 */
export function isCorruptOfficeFileError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("end of central directory");
}
