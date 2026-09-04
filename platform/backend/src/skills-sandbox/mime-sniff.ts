/**
 * Server-side mime sniffing for sandbox artifacts.
 *
 * The MCP tool input lets the model supply a `mimeType`, but a prompt-injected
 * (or just confused) agent could claim `image/png` over an HTML payload. The
 * artifact storage layer always sniffs the actual bytes and overrides the
 * stored mime when the claim disagrees with a known signature, so the
 * download endpoint and inline-image renderer can trust the column.
 *
 * Only the inline-safe formats are sniffed: the raster images, plus PDF. SVG
 * and other text formats are intentionally NOT sniffed back to anything
 * specific — they stay as whatever the caller declared (or
 * `application/octet-stream`) and are served as downloads.
 */

const INLINE_SAFE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Returns the sniffed image mime, or null if no known signature matches. */
export function sniffInlineSafeImageMime(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    hasMagic(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && hasMagic(buffer, 0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    hasMagic(buffer, 0, [0x52, 0x49, 0x46, 0x46]) &&
    hasMagic(buffer, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  if (buffer.length >= 6 && hasMagic(buffer, 0, [0x47, 0x49, 0x46, 0x38])) {
    const v = buffer[4];
    if ((v === 0x37 || v === 0x39) && buffer[5] === 0x61) return "image/gif";
  }
  return null;
}

/**
 * Reconcile a caller-claimed mime with sniffed bytes. The result is what
 * actually gets persisted in `skill_sandbox_files.mime_type`.
 *
 * Rules:
 *   - if bytes match a known image or PDF signature, the sniffed mime always
 *     wins (the caller cannot mislabel a PNG as `image/svg+xml` to bypass the
 *     inline-safe filter, nor mislabel an HTML page as `image/png` to get
 *     served as an image)
 *   - otherwise, fall back to the caller's claim, or `application/octet-stream`
 */
export function resolveArtifactMime(params: {
  buffer: Buffer;
  claimed: string | undefined;
}): string {
  const sniffed = sniffInlineSafeImageMime(params.buffer);
  if (sniffed) return sniffed;
  // A tool that writes a report to disk and downloads it often claims nothing,
  // so sniffing is what lets the stored row say `application/pdf` and the
  // viewer offer a preview instead of a download prompt.
  if (isPdfBuffer(params.buffer)) return "application/pdf";
  return params.claimed ?? "application/octet-stream";
}

/**
 * Whether these bytes really are a PDF (`%PDF-` signature).
 *
 * The serve path asks the BYTES, not the stored mime, before it hands a file
 * to the browser's PDF viewer: the column is caller-influenced, so a payload
 * mislabelled `application/pdf` must not earn the viewer's relaxed CSP. Bytes
 * cannot lie about this, and it also rescues rows persisted as
 * `application/octet-stream` before PDFs were sniffed at write time.
 */
export function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length >= 5 && hasMagic(buffer, 0, PDF_MAGIC);
}

/** `%PDF-` — the signature every PDF opens with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

export function isInlineSafeImageMime(mime: string): boolean {
  return INLINE_SAFE_MIMES.has(mime);
}

/**
 * Cheap, display-only mime from a filename extension — used for disk-only file
 * LISTINGS, where reading every file to byte-sniff would be wasteful. The actual
 * download path still byte-sniffs and serves with `nosniff`, so this is never a
 * security control. Unknown extensions fall back to `application/octet-stream`.
 */
export function mimeFromExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return EXTENSION_MIMES[ext] ?? "application/octet-stream";
}

const EXTENSION_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  zip: "application/zip",
};

function hasMagic(buffer: Buffer, offset: number, magic: number[]): boolean {
  for (let i = 0; i < magic.length; i++) {
    if (buffer[offset + i] !== magic[i]) return false;
  }
  return true;
}
