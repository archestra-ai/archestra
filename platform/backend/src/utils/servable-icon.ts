/**
 * Image types a browser shows in an `<img>`. The catalog icon route serves
 * only these, so an upload of any other type never reaches a browser under its
 * own content type. SVG stays: many server icons are SVG, and the route's CSP
 * (`default-src 'none'; sandbox`) blocks its scripts and every fetch.
 */
export const SERVABLE_ICON_TYPES: ReadonlySet<string> = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

/** A `data:` URL of a servable image type. */
export function isServableIconDataUrl(value: string): boolean {
  const mimeType = /^data:(image\/[a-z0-9.+-]+)[;,]/i.exec(value)?.[1];
  return !!mimeType && SERVABLE_ICON_TYPES.has(mimeType.toLowerCase());
}
