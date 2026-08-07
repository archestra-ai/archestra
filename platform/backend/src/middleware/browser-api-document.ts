import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

const DEFAULT_FAVICON_PATH = "/default-favicon.ico";
const FAVICON_PATH = "/favicon.ico";
const PNG_DATA_URI_PREFIX = "data:image/png;base64,";

/**
 * Raw JSON documents cannot declare their own favicon. Render a minimal HTML
 * document only for top-level navigations, using Fetch Metadata when available
 * and explicit HTML content negotiation as a fallback for user agents that do
 * not send those headers.
 */
export function shouldRenderBrowserApiDocument(request: FastifyRequest) {
  return (
    request.method === "GET" &&
    isApiRequestUrl(request.url) &&
    isDocumentNavigation(request.headers)
  );
}

export function isApiRequestUrl(requestUrl: string) {
  if (requestUrl.startsWith("/")) {
    const delimiter = requestUrl.search(/[?#]/);
    const pathname =
      delimiter === -1 ? requestUrl : requestUrl.slice(0, delimiter);
    return pathname === "/api" || pathname.startsWith("/api/");
  }

  try {
    const pathname = new URL(requestUrl, "http://localhost").pathname;
    return pathname === "/api" || pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function isDocumentNavigation(headers: FastifyRequest["headers"]) {
  const destination = normalizedHeader(headers["sec-fetch-dest"]);
  const mode = normalizedHeader(headers["sec-fetch-mode"]);

  // Explicit Fetch Metadata is authoritative. This prevents fetch/XHR calls
  // that happen to accept HTML from being rewritten as browser documents.
  if (destination && destination !== "document") return false;
  if (mode && mode !== "navigate") return false;
  if (destination === "document") return true;

  return acceptsHtml(headers.accept);
}

function acceptsHtml(value: string | string[] | undefined) {
  const accept = normalizedHeader(value);
  if (!accept) return false;

  return accept.split(",").some((range) => {
    const [mediaType, ...parameters] = range.split(";");
    if (mediaType.trim() !== "text/html") return false;

    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

function normalizedHeader(value: string | string[] | undefined) {
  const header = Array.isArray(value) ? value.join(",") : value;
  return header?.trim().toLowerCase();
}

export function isJsonContentType(contentType: unknown) {
  return (
    typeof contentType === "string" &&
    /^(?:application\/json|[^;]+\+json)(?:;|$)/i.test(contentType)
  );
}

export function getBrowserApiFaviconHref(favicon: string | null) {
  if (!favicon?.startsWith(PNG_DATA_URI_PREFIX)) {
    return DEFAULT_FAVICON_PATH;
  }

  const version = createHash("sha256")
    .update(favicon)
    .digest("hex")
    .slice(0, 16);
  return `${FAVICON_PATH}?v=${version}`;
}

export function renderBrowserApiDocument(payload: string, faviconHref: string) {
  const escapedPayload = payload
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><link rel="icon" href="${faviconHref}"></head><body><pre>${escapedPayload}</pre></body></html>`;
}
