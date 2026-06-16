export const SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS = [
  "txt",
  "md",
  "csv",
  "json",
  "xml",
  "pdf",
] as const;

export const SUPPORTED_KNOWLEDGE_FILE_MIME_TYPES = [
  "application/csv",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/vnd.ms-excel",
  "application/xml",
  "text/xml",
  "application/pdf",
] as const;

export const KNOWLEDGE_FILE_ACCEPT_ATTRIBUTE =
  SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(
    ",",
  );

export const KNOWLEDGE_FILE_SUPPORTED_FORMATS_LABEL =
  "TXT, Markdown, CSV, JSON, XML, and PDF";

export const MAX_KNOWLEDGE_FILES_PER_UPLOAD = 20;

/**
 * Content-Type to serve a knowledge file with when rendering it inline (file
 * preview), or `null` when the file must be downloaded as an attachment.
 *
 * Decided by extension, not the stored mime: a `.md` uploaded with an empty or
 * `text/markdown` mime would otherwise be forced to download under the content
 * endpoint's `nosniff` header. Text-family files are coerced to `text/plain` so
 * the browser renders them as readable text and never executes them as script.
 */
export function knowledgeFileInlineContentType(
  fileName: string,
): string | null {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (!extension) return null;
  if (extension === "pdf") return "application/pdf";
  if (
    (SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS as readonly string[]).includes(
      extension,
    )
  ) {
    return "text/plain; charset=utf-8";
  }
  return null;
}
