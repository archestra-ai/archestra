import {
  isPdfBuffer,
  sniffInlineSafeImageMime,
} from "@/skills-sandbox/mime-sniff";

/**
 * The media a public file link may serve, decided from the file's BYTES only.
 * The stored mime column and the filename are caller-influenced, so neither is
 * trusted: an HTML page or an SVG (which can carry script) never qualifies,
 * whatever it is named or labelled.
 *
 * Allowed: PNG, JPEG, GIF, WebP images; MP4 and WebM video; PDF.
 */
export const PUBLIC_FILE_ALLOWED_TYPES_LABEL =
  "PNG, JPEG, GIF, WebP, MP4, WebM, or PDF";

/** The media type to serve these bytes as, or null when they may not be shared. */
export function sniffPublicFileMime(buffer: Buffer): string | null {
  const image = sniffInlineSafeImageMime(buffer);
  if (image) return image;
  if (isPdfBuffer(buffer)) return "application/pdf";
  if (isMp4(buffer)) return "video/mp4";
  if (isWebm(buffer)) return "video/webm";
  return null;
}

/** The usual file extension for a media type {@link sniffPublicFileMime} returns. */
export function extensionForPublicFileMime(mimeType: string): string | null {
  return EXTENSIONS[mimeType] ?? null;
}

// === internal helpers ===

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/**
 * ISO base media `ftyp` brands that are MP4 video. QuickTime (`qt  `) and the
 * HEIF/AVIF still-image brands share the container but are not MP4 video, so
 * they are not on the list.
 */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "dash",
  "mmp4",
]);

function isMp4(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer.toString("latin1", 4, 8) !== "ftyp") return false;
  return MP4_BRANDS.has(buffer.toString("latin1", 8, 12));
}

/** EBML magic, then a `webm` DocType near the start (Matroska says `matroska`). */
function isWebm(buffer: Buffer): boolean {
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x1a ||
    buffer[1] !== 0x45 ||
    buffer[2] !== 0xdf ||
    buffer[3] !== 0xa3
  ) {
    return false;
  }
  return buffer.subarray(0, 64).includes("webm", 0, "latin1");
}
