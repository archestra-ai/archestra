import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "@/types";

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

/**
 * The registry icon route's link for a content version token. Any edit to the
 * icon must yield a new token, so a cached image is never stale.
 */
export function catalogIconUrl(catalogId: string, version: string): string {
  return `/api/internal_mcp_catalog/${catalogId}/icon?v=${version}`;
}

/** The app icon route's link for a content version token, as above. */
export function appIconUrl(appId: string, version: string): string {
  return `/api/apps/${appId}/icon?v=${version}`;
}

/** The external app icon route's link for a content version token, as above. */
export function externalAppIconUrl(catalogId: string, version: string): string {
  return `/api/apps/external/${catalogId}/icon?v=${version}`;
}

/**
 * A list item's icon split for the wire: an emoji (or other text) stays inline
 * as `icon`, while an image `data:` URL becomes `iconUrl`, a content-versioned
 * link to an icon route. Image icons can run to hundreds of kilobytes, and a
 * list would otherwise resend every one on each request; the browser keeps a
 * linked icon until its content changes.
 */
export function splitListIcon(
  icon: string | null,
  urlFor: (version: string) => string,
): { icon: string | null; iconUrl: string | null } {
  if (!icon?.startsWith("data:")) return { icon, iconUrl: null };
  return {
    icon: null,
    iconUrl: isServableIconDataUrl(icon) ? urlFor(iconVersion(icon)) : null,
  };
}

/**
 * Answer an icon route with the image a stored `data:` URL holds. The URL a
 * list links carries the content version, so the browser may keep the image;
 * the ETag answers a revalidation without the bytes. 404 for anything that is
 * not a servable image.
 */
export function replyWithIconImage(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  icon: string | null;
}): FastifyReply {
  const { request, reply, icon } = params;
  const image = icon ? decodeImageDataUrl(icon) : null;
  if (!icon || !image) {
    throw new ApiError(404, "Icon not found");
  }
  const etag = `"${iconVersion(icon)}"`;
  void reply
    .header("ETag", etag)
    .header("Cache-Control", "private, max-age=31536000, immutable")
    .header("X-Content-Type-Options", "nosniff")
    .header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  if (request.headers["if-none-match"] === etag) {
    return reply.code(304).send();
  }
  return reply.header("Content-Type", image.mimeType).send(image.bytes);
}

// ===

/** A `data:` URL of a servable image type. */
function isServableIconDataUrl(value: string): boolean {
  const mimeType = /^data:(image\/[a-z0-9.+-]+)[;,]/i.exec(value)?.[1];
  return !!mimeType && SERVABLE_ICON_TYPES.has(mimeType.toLowerCase());
}

function iconVersion(icon: string): string {
  return createHash("sha256").update(icon).digest("base64url").slice(0, 16);
}

/** The bytes of an image `data:` URL, or null for anything else. */
function decodeImageDataUrl(
  value: string,
): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is.exec(value);
  if (!match) return null;
  const [, mimeType, base64, payload] = match;
  if (!SERVABLE_ICON_TYPES.has(mimeType.toLowerCase())) return null;
  try {
    return {
      mimeType: mimeType.toLowerCase(),
      bytes: base64
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload), "utf8"),
    };
  } catch {
    return null;
  }
}
