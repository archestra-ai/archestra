import crypto from "node:crypto";
import ipaddr from "ipaddr.js";
import logger from "@/logging";
import { OAuthClientModel } from "@/models";
import type { CimdMetadata } from "@/types";

/**
 * Client ID Metadata Documents (CIMD) support for MCP OAuth 2.1.
 *
 * CIMD allows MCP clients to use an HTTPS URL as their `client_id`.
 * The authorization server fetches client metadata from that URL
 * instead of requiring pre-registration via DCR.
 *
 * See: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
 */

/**
 * Detect whether a client_id is a CIMD URL (has scheme + path component).
 */
export function isCimdClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    // Must have http or https scheme and a path component beyond just "/"
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

/**
 * Fetch and validate a CIMD metadata document from the client_id URL.
 */
export async function fetchAndValidateCimdDocument(
  clientIdUrl: string,
): Promise<CimdMetadata> {
  const url = new URL(clientIdUrl);

  // Warn about HTTP CIMD URLs — HTTPS is recommended but not enforced.
  // The MCP spec says the AS "SHOULD" reject HTTP (not "MUST"), and
  // enforcement here breaks internal environments (CI, K8s pod-to-pod).
  if (url.protocol !== "https:") {
    logger.warn(
      { clientIdUrl },
      "[cimd] CIMD client_id uses HTTP — HTTPS is recommended for production",
    );
  }

  // SSRF mitigation: block private/loopback IP addresses.
  // Hostnames that resolve to private IPs are still possible (DNS rebinding),
  // but blocking obvious cases covers the common attack surface.
  if (isPrivateHost(url.hostname)) {
    throw new CimdError(
      `CIMD client_id URL must not point to a private or loopback address: ${url.hostname}`,
    );
  }

  const response = await fetch(clientIdUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    redirect: "error", // Don't follow redirects (prevents redirect-based SSRF)
  });

  if (!response.ok) {
    throw new CimdError(
      `Failed to fetch CIMD document from ${clientIdUrl}: HTTP ${response.status}`,
    );
  }

  // Limit response size to 1 MB to prevent memory exhaustion
  const body = await response.text();
  if (body.length > MAX_CIMD_BODY_SIZE) {
    throw new CimdError(
      `CIMD document exceeds maximum size of ${MAX_CIMD_BODY_SIZE} bytes`,
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw new CimdError(`CIMD document at ${clientIdUrl} is not valid JSON`);
  }

  return validateCimdDocument(clientIdUrl, document);
}

/**
 * Ensure a CIMD client is registered in the database.
 * Fetches the document, validates it, and upserts the client row.
 */
export async function ensureCimdClientRegistered(
  clientIdUrl: string,
): Promise<void> {
  // Check cache first
  const cached = cimdCache.get(clientIdUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return;
  }

  logger.debug(
    { clientIdUrl },
    "[cimd] Fetching CIMD document for auto-registration",
  );

  const metadata = await fetchAndValidateCimdDocument(clientIdUrl);

  await OAuthClientModel.upsertFromCimd({
    id: crypto.randomUUID(),
    clientId: clientIdUrl,
    name: metadata.client_name,
    redirectUris: metadata.redirect_uris,
    grantTypes: metadata.grant_types ?? ["authorization_code"],
    responseTypes: metadata.response_types ?? ["code"],
    tokenEndpointAuthMethod: "none",
    isPublic: true,
    metadata: {
      cimd: true,
      documentUrl: clientIdUrl,
      fetchedAt: new Date().toISOString(),
    },
    contacts: metadata.contacts,
    uri: metadata.client_uri,
    policy: metadata.policy_uri,
    tos: metadata.tos_uri,
    softwareId: metadata.software_id,
    softwareVersion: metadata.software_version,
  });

  // Update cache, evicting stale entries if it grows too large
  if (cimdCache.size >= MAX_CACHE_SIZE) {
    evictStaleEntries();
  }
  cimdCache.set(clientIdUrl, { fetchedAt: Date.now() });

  logger.info(
    { clientIdUrl, clientName: metadata.client_name },
    "[cimd] Auto-registered CIMD client",
  );
}

// ===  Internal helpers ===

export class CimdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CimdError";
  }
}

/** Cache TTL: 5 minutes */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Max cache entries to prevent unbounded memory growth */
const MAX_CACHE_SIZE = 10_000;

/** Max CIMD document body size: 1 MB */
const MAX_CIMD_BODY_SIZE = 1_024 * 1_024;

/** In-memory cache to avoid re-fetching on every request */
const cimdCache = new Map<string, { fetchedAt: number }>();

export function validateCimdDocument(
  clientIdUrl: string,
  document: unknown,
): CimdMetadata {
  if (typeof document !== "object" || document === null) {
    throw new CimdError("CIMD document must be a JSON object");
  }

  const doc = document as Record<string, unknown>;

  // client_id MUST match the URL exactly
  if (doc.client_id !== clientIdUrl) {
    throw new CimdError(
      `CIMD document client_id "${doc.client_id}" does not match the URL "${clientIdUrl}"`,
    );
  }

  // client_name is required
  if (typeof doc.client_name !== "string" || doc.client_name.length === 0) {
    throw new CimdError("CIMD document must include a non-empty client_name");
  }

  // redirect_uris is required and must be a non-empty array of strings
  if (
    !Array.isArray(doc.redirect_uris) ||
    doc.redirect_uris.length === 0 ||
    !doc.redirect_uris.every((uri: unknown) => typeof uri === "string")
  ) {
    throw new CimdError(
      "CIMD document must include redirect_uris as a non-empty array of strings",
    );
  }

  return {
    client_id: doc.client_id as string,
    client_name: doc.client_name as string,
    redirect_uris: doc.redirect_uris as string[],
    grant_types: asOptionalStringArray(doc.grant_types),
    response_types: asOptionalStringArray(doc.response_types),
    token_endpoint_auth_method: asOptionalString(
      doc.token_endpoint_auth_method,
    ),
    scope: asOptionalString(doc.scope),
    contacts: asOptionalStringArray(doc.contacts),
    logo_uri: asOptionalString(doc.logo_uri),
    client_uri: asOptionalString(doc.client_uri),
    policy_uri: asOptionalString(doc.policy_uri),
    tos_uri: asOptionalString(doc.tos_uri),
    software_id: asOptionalString(doc.software_id),
    software_version: asOptionalString(doc.software_version),
  };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (
    Array.isArray(value) &&
    value.every((v: unknown) => typeof v === "string")
  ) {
    return value as string[];
  }
  return undefined;
}

/** Ranges from ipaddr.js that should be blocked for SSRF mitigation. */
const BLOCKED_RANGES = new Set([
  "loopback",
  "private",
  "linkLocal",
  "unspecified",
  "broadcast",
  "carrierGradeNat",
  "reserved",
  "uniqueLocal", // IPv6 fc00::/7
  "multicast",
]);

/**
 * Check if a hostname is a private/loopback address (SSRF mitigation).
 * Uses ipaddr.js for comprehensive RFC-based range detection covering IPv4 and IPv6.
 */
function isPrivateHost(hostname: string): boolean {
  if (hostname.toLowerCase() === "localhost") return true;

  // Strip brackets from IPv6 addresses (URLs use [::1] format, but ipaddr.js expects ::1)
  const normalized =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (!ipaddr.isValid(normalized)) return false;

  const addr = ipaddr.parse(normalized);
  return BLOCKED_RANGES.has(addr.range());
}

/** Evict expired entries from the CIMD cache */
function evictStaleEntries(): void {
  const now = Date.now();
  for (const [key, entry] of cimdCache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) {
      cimdCache.delete(key);
    }
  }
}
