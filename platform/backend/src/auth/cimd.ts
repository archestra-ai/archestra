import crypto from "node:crypto";
import config from "@/config";
import logger from "@/logging";
import { OAuthClientModel } from "@/models";

/**
 * Client ID Metadata Documents (CIMD) support for MCP OAuth 2.1.
 *
 * CIMD allows MCP clients to use an HTTPS URL as their `client_id`.
 * The authorization server fetches client metadata from that URL
 * instead of requiring pre-registration via DCR.
 *
 * See: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
 */

interface CimdMetadata {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  contacts?: string[];
  logo_uri?: string;
  client_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
  software_id?: string;
  software_version?: string;
}

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
  // Enforce HTTPS in production; allow HTTP in dev/test
  if (config.production) {
    const url = new URL(clientIdUrl);
    if (url.protocol !== "https:") {
      throw new CimdError("CIMD client_id must use HTTPS in production");
    }
  }

  const response = await fetch(clientIdUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new CimdError(
      `Failed to fetch CIMD document from ${clientIdUrl}: HTTP ${response.status}`,
    );
  }

  let document: unknown;
  try {
    document = await response.json();
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

  // Update cache
  cimdCache.set(clientIdUrl, { fetchedAt: Date.now() });

  logger.info(
    { clientIdUrl, clientName: metadata.client_name },
    "[cimd] Auto-registered CIMD client",
  );
}

// ===  Internal helpers ===

class CimdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CimdError";
  }
}

/** Cache TTL: 5 minutes */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** In-memory cache to avoid re-fetching on every request */
const cimdCache = new Map<string, { fetchedAt: number }>();

function validateCimdDocument(
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
