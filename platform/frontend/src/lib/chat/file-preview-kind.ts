export type FilePreviewKind =
  | "markdown"
  | "html"
  | "image"
  | "svg"
  | "text"
  | "csv"
  | "pdf"
  | "unsupported";

/**
 * Image mimes the backend serves inline, so an <img> can point straight at the
 * byte endpoint. SVG is deliberately not here: it is served download-only and
 * rendered from a client-built data: URL instead (see the `svg` kind).
 */
const INLINE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * How a file should render in the Files detail view. Everything not explicitly
 * supported is `unsupported` (download-only). Checked most-specific first.
 */
export function getFilePreviewKind(
  mimeType: string,
  name: string,
): FilePreviewKind {
  const mime = mimeType.toLowerCase();
  const lowerName = name.toLowerCase();

  if (mime === "text/markdown" || lowerName.endsWith(".md")) return "markdown";
  // Checked before the generic `text/*` branch (text/html starts with text/).
  if (
    mime === "text/html" ||
    lowerName.endsWith(".html") ||
    lowerName.endsWith(".htm")
  ) {
    return "html";
  }
  if (mime === "image/svg+xml" || lowerName.endsWith(".svg")) return "svg";
  if (INLINE_IMAGE_MIMES.has(mime)) return "image";
  // Rendered via an iframe pointing at the byte endpoint, which serves PDFs
  // inline — the browser's own viewer does the work.
  if (mime === "application/pdf" || lowerName.endsWith(".pdf")) return "pdf";
  if (mime === "text/csv" || lowerName.endsWith(".csv")) return "csv";
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  // Sniffing short plain-text files often yields application/octet-stream,
  // so fall back to well-known text extensions.
  if (
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".log") ||
    lowerName.endsWith(".json")
  ) {
    return "text";
  }
  return "unsupported";
}
