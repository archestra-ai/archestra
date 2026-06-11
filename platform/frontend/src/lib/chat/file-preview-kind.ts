export type FilePreviewKind =
  | "markdown"
  | "html"
  | "image"
  | "text"
  | "csv"
  | "unsupported";

/** Image mimes the backend serves inline; only these can render via <img>. */
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
  if (INLINE_IMAGE_MIMES.has(mime)) return "image";
  if (mime === "text/csv" || lowerName.endsWith(".csv")) return "csv";
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  return "unsupported";
}
