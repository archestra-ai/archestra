/**
 * Best-effort mime type from a filename extension, for filesystem files that
 * have no DB row (so no persisted mime). Cosmetic only — drives the list icon;
 * such files are not downloadable. Unknown/missing → application/octet-stream.
 */
export function mimeFromExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}

const EXTENSION_MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
