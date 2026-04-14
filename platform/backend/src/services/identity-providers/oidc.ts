import type { IdentityProviderOidcConfig } from "@shared";
import { eq } from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import db, { schema as dbSchema } from "@/database";
import logger from "@/logging";

export interface ExternalIdentityProviderConfig {
  id: string;
  providerId: string;
  issuer: string;
  oidcConfig: ExternalIdentityProviderOidcConfig | null;
}

export interface ExternalIdentityProviderOidcConfig {
  clientId?: string;
  jwksEndpoint?: string;
  tokenEndpoint?: string;
  discoveryEndpoint?: string;
  clientSecret?: string;
  tokenEndpointAuthentication?:
    | "client_secret_post"
    | "client_secret_basic"
    | "private_key_jwt";
  enterpriseManagedCredentials?: IdentityProviderOidcConfig["enterpriseManagedCredentials"];
}

export async function findExternalIdentityProviderById(
  identityProviderId: string,
): Promise<ExternalIdentityProviderConfig | null> {
  const [provider] = await db
    .select({
      id: dbSchema.identityProvidersTable.id,
      providerId: dbSchema.identityProvidersTable.providerId,
      issuer: dbSchema.identityProvidersTable.issuer,
      oidcConfig: dbSchema.identityProvidersTable.oidcConfig,
    })
    .from(dbSchema.identityProvidersTable)
    .where(eq(dbSchema.identityProvidersTable.id, identityProviderId));

  if (!provider) {
    return null;
  }

  return {
    id: provider.id,
    providerId: provider.providerId,
    issuer: provider.issuer,
    oidcConfig: parseJsonField<ExternalIdentityProviderOidcConfig>(
      provider.oidcConfig,
    ),
  };
}

export async function findExternalIdentityProviderByProviderId(
  providerId: string,
): Promise<ExternalIdentityProviderConfig | null> {
  const [provider] = await db
    .select({
      id: dbSchema.identityProvidersTable.id,
      providerId: dbSchema.identityProvidersTable.providerId,
      issuer: dbSchema.identityProvidersTable.issuer,
      oidcConfig: dbSchema.identityProvidersTable.oidcConfig,
    })
    .from(dbSchema.identityProvidersTable)
    .where(eq(dbSchema.identityProvidersTable.providerId, providerId));

  if (!provider) {
    return null;
  }

  return {
    id: provider.id,
    providerId: provider.providerId,
    issuer: provider.issuer,
    oidcConfig: parseJsonField<ExternalIdentityProviderOidcConfig>(
      provider.oidcConfig,
    ),
  };
}

export async function discoverOidcJwksUrl(
  issuerUrl: string,
): Promise<string | null> {
  const cached = oidcDiscoveryCache.get(issuerUrl);
  if (cached) return cached;

  const inflight = oidcDiscoveryInflight.get(issuerUrl);
  if (inflight) return inflight;

  const promise = fetchOidcJwksUrl(issuerUrl);
  oidcDiscoveryInflight.set(issuerUrl, promise);
  try {
    return await promise;
  } finally {
    oidcDiscoveryInflight.delete(issuerUrl);
  }
}

export async function discoverOidcTokenEndpoint(
  issuerUrl: string,
): Promise<string | null> {
  const metadata = await discoverOidcMetadata(issuerUrl);
  return metadata?.token_endpoint ?? null;
}

export function parseJsonField<T>(value: unknown): T | null {
  if (!value) return null;
  if (typeof value === "object") return value as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

// =============================================================================
// Internal helpers
// =============================================================================

const MAX_OIDC_DISCOVERY_CACHE_SIZE = 100;
const OIDC_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const oidcDiscoveryCache = new LRUCacheManager<string>({
  maxSize: MAX_OIDC_DISCOVERY_CACHE_SIZE,
  defaultTtl: OIDC_DISCOVERY_CACHE_TTL_MS,
});
const oidcMetadataCache = new LRUCacheManager<OidcMetadata>({
  maxSize: MAX_OIDC_DISCOVERY_CACHE_SIZE,
  defaultTtl: OIDC_DISCOVERY_CACHE_TTL_MS,
});
const oidcDiscoveryInflight = new Map<string, Promise<string | null>>();
const oidcMetadataInflight = new Map<string, Promise<OidcMetadata | null>>();

async function fetchOidcJwksUrl(issuerUrl: string): Promise<string | null> {
  const metadata = await discoverOidcMetadata(issuerUrl);
  const jwksUri = metadata?.jwks_uri;
  if (!jwksUri || typeof jwksUri !== "string") {
    logger.warn({ issuerUrl }, "OIDC discovery: no jwks_uri in metadata");
    return null;
  }

  oidcDiscoveryCache.set(issuerUrl, jwksUri);
  return jwksUri;
}

async function discoverOidcMetadata(
  issuerUrl: string,
): Promise<OidcMetadata | null> {
  const cached = oidcMetadataCache.get(issuerUrl);
  if (cached) {
    return cached;
  }

  const inflight = oidcMetadataInflight.get(issuerUrl);
  if (inflight) {
    return inflight;
  }

  const promise = fetchOidcMetadata(issuerUrl);
  oidcMetadataInflight.set(issuerUrl, promise);
  try {
    return await promise;
  } finally {
    oidcMetadataInflight.delete(issuerUrl);
  }
}

async function fetchOidcMetadata(
  issuerUrl: string,
): Promise<OidcMetadata | null> {
  try {
    const normalizedIssuer = issuerUrl.replace(/\/$/, "");
    const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;

    const response = await fetch(discoveryUrl, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      logger.warn(
        { issuerUrl, status: response.status },
        "OIDC discovery failed",
      );
      return null;
    }

    const metadata = (await response.json()) as OidcMetadata;
    oidcMetadataCache.set(issuerUrl, metadata);
    return metadata;
  } catch (error) {
    logger.warn(
      {
        issuerUrl,
        error: error instanceof Error ? error.message : String(error),
      },
      "OIDC discovery request failed",
    );
    return null;
  }
}

interface OidcMetadata {
  jwks_uri?: string;
  token_endpoint?: string;
}
