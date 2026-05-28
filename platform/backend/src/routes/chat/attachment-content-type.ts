const SAFE_INLINE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

/**
 * Coerce script-carrier mime types to `application/octet-stream` before they
 * are sent to a client. The mime arrives via the client-supplied data: URL
 * header and cannot be trusted. Anything a browser would parse as HTML, SVG,
 * or JavaScript is downgraded so even a same-origin fetch cannot execute
 * script from a stored attachment.
 */
export function sanitizeAttachmentContentType(mime: string): string {
  const lower = mime.toLowerCase();
  if (
    lower === "text/html" ||
    lower === "image/svg+xml" ||
    lower === "application/xhtml+xml" ||
    lower.startsWith("application/javascript") ||
    lower.startsWith("text/javascript") ||
    lower.startsWith("text/xml")
  ) {
    return "application/octet-stream";
  }
  return mime;
}

/**
 * Returns true only for mime types the download endpoint may serve with
 * `Content-Disposition: inline`. Anything outside this allow-list is
 * downloaded as an attachment so the browser never tries to render it.
 */
export function isSafeInlineMimeType(mime: string): boolean {
  return SAFE_INLINE_MIME_TYPES.has(mime.toLowerCase());
}
