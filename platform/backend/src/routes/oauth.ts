import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_APP_NAME,
  OFFLINE_ACCESS_OAUTH_SCOPE,
  RouteId,
} from "@archestra/shared";
import { exchangeAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { InternalMcpCatalogModel, OrganizationModel } from "@/models";
import { isByosEnabled, secretManager } from "@/secrets-manager";
import { ApiError, constructResponseSchema, UuidIdSchema } from "@/types";

/**
 * Generate PKCE code verifier
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Generate PKCE code challenge from verifier
 */
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface OAuthDiscoveryOverrides {
  authServerUrl?: string;
  resourceMetadataUrl?: string;
  wellKnownUrl?: string;
}

interface OAuthScopeConfig {
  server_url: string;
  supports_resource_metadata?: boolean;
  scopes?: string[];
  default_scopes?: string[];
  auth_server_url?: string;
  resource_metadata_url?: string;
  well_known_url?: string;
}

/**
 * Discover OAuth resource metadata (for MCP servers)
 * Sends MCP-Protocol-Version header for MCP-aware servers
 */
async function discoverOAuthResourceMetadata(
  serverUrl: string,
  overrides?: OAuthDiscoveryOverrides,
) {
  try {
    // MCP SDK uses "path-aware discovery": /.well-known/{type}{pathname}
    // For https://huggingface.co/mcp -> https://huggingface.co/.well-known/oauth-protected-resource/mcp
    const url = new URL(serverUrl);
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    const wellKnownUrl =
      overrides?.resourceMetadataUrl ||
      `${url.origin}/.well-known/oauth-protected-resource${pathname}`;

    const response = await fetch(wellKnownUrl, {
      headers: {
        "MCP-Protocol-Version": "2025-06-18",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch resource metadata: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    throw new Error(
      `Resource metadata discovery failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Discover OAuth scopes from server metadata
 * Tries multiple discovery methods like the desktop app does
 */
export async function discoverScopes(
  serverUrl: string,
  supportsResourceMetadata: boolean,
  defaultScopes: string[],
  overrides?: OAuthDiscoveryOverrides,
): Promise<string[]> {
  // Try resource metadata discovery first if supported
  const shouldDiscoverResourceMetadata =
    supportsResourceMetadata &&
    (!overrides?.authServerUrl || !!overrides.resourceMetadataUrl);

  if (shouldDiscoverResourceMetadata) {
    try {
      const resourceMetadata = await discoverOAuthResourceMetadata(
        serverUrl,
        overrides,
      );
      if (
        resourceMetadata?.scopes_supported &&
        Array.isArray(resourceMetadata.scopes_supported) &&
        resourceMetadata.scopes_supported.length > 0
      ) {
        return resourceMetadata.scopes_supported;
      }
    } catch (error) {
      logger.error(error);
    }
  }

  // Try authorization server metadata discovery
  try {
    const metadata = await discoverAuthorizationServerMetadataWithOverrides(
      serverUrl,
      overrides,
    );
    if (
      metadata.scopes_supported &&
      Array.isArray(metadata.scopes_supported) &&
      metadata.scopes_supported.length > 0
    ) {
      return metadata.scopes_supported;
    }
  } catch (error) {
    logger.error(error);
  }

  // Fall back to default scopes
  return defaultScopes;
}

export async function resolveOAuthScopesForAuthorization(params: {
  oauthConfig: OAuthScopeConfig;
}): Promise<{
  configuredScopes: string[];
  discoveredScopes: string[];
  scopesToUse: string[];
}> {
  const configuredScopes = params.oauthConfig.scopes ?? [];
  if (configuredScopes.length > 0) {
    return {
      configuredScopes,
      discoveredScopes: [],
      scopesToUse: withOfflineAccess(configuredScopes),
    };
  }

  const fallbackScopes = params.oauthConfig.default_scopes ?? [];

  const discoveredScopes = await discoverScopes(
    params.oauthConfig.server_url,
    params.oauthConfig.supports_resource_metadata || false,
    fallbackScopes,
    {
      authServerUrl: params.oauthConfig.auth_server_url,
      resourceMetadataUrl: params.oauthConfig.resource_metadata_url,
      wellKnownUrl: params.oauthConfig.well_known_url,
    },
  );

  return {
    configuredScopes,
    discoveredScopes,
    scopesToUse: withOfflineAccess(discoveredScopes),
  };
}

/**
 * Ensure `offline_access` is in the requested scopes so the token endpoint
 * issues a refresh token. It's a behavioral OIDC scope rather than a resource
 * scope, so providers like Microsoft Entra omit it from `scopes_supported` and
 * only return a refresh token when it's explicitly requested. Without it, a
 * server's access token silently expires with no way to refresh, surfacing
 * later as a `no_refresh_token` error. Requested for every authorization_code
 * flow, mirroring the inbound OAuth provider side (see `mcp-oauth-client.ts`).
 * The configured/discovered scopes are reported unchanged; only the set we
 * actually request is augmented.
 */
function withOfflineAccess(scopes: string[]): string[] {
  return scopes.includes(OFFLINE_ACCESS_OAUTH_SCOPE)
    ? scopes
    : [...scopes, OFFLINE_ACCESS_OAUTH_SCOPE];
}

/**
 * Build discovery URLs to try for authorization server metadata
 * Implements the same fallback strategy as MCP SDK
 */
export function buildDiscoveryUrls(
  serverUrl: string,
  wellKnownUrl?: string,
): string[] {
  if (wellKnownUrl) {
    return [wellKnownUrl];
  }

  const url = new URL(serverUrl);
  const hasPath = url.pathname !== "/" && url.pathname !== "";
  const urls: string[] = [];

  if (!hasPath) {
    // Root path: try OAuth then OIDC
    urls.push(`${url.origin}/.well-known/oauth-authorization-server`);
    urls.push(`${url.origin}/.well-known/openid-configuration`);
    return urls;
  }

  // Strip trailing slash
  let pathname = url.pathname;
  if (pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  // Try path-aware OAuth first, then root OAuth, then OIDC variants
  urls.push(`${url.origin}/.well-known/oauth-authorization-server${pathname}`);
  urls.push(`${url.origin}/.well-known/oauth-authorization-server`);
  urls.push(`${url.origin}/.well-known/openid-configuration${pathname}`);
  urls.push(`${url.origin}${pathname}/.well-known/openid-configuration`);

  return urls;
}

/**
 * Discover OAuth authorization server metadata with fallback support
 * Tries multiple discovery URLs like the MCP SDK does
 */
async function discoverAuthorizationServerMetadataWithOverrides(
  serverUrl: string,
  overrides?: OAuthDiscoveryOverrides,
): Promise<{
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}> {
  const discoveryUrl = overrides?.authServerUrl || serverUrl;
  const urls = buildDiscoveryUrls(discoveryUrl, overrides?.wellKnownUrl);

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          "MCP-Protocol-Version": "2025-06-18",
        },
      });

      // If we get a 4xx error, try the next URL
      if (!response.ok && response.status >= 400 && response.status < 500) {
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} from discovery endpoint: ${url}`,
        );
      }

      const metadata = await response.json();

      // Validate that we got the required fields
      if (metadata.authorization_endpoint && metadata.token_endpoint) {
        return metadata;
      }
    } catch (error) {
      // If this is the last URL, throw the error
      if (url === urls[urls.length - 1]) {
        throw new Error(
          `Authorization server metadata discovery failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }
  }

  throw new Error(
    "Authorization server metadata discovery failed: No valid metadata found at any discovery endpoint",
  );
}

interface DiscoveredEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}

interface ExplicitOAuthEndpoints {
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
}

/**
 * Discover OAuth endpoints via resource metadata → auth server metadata chain.
 * Shared by the initiate, callback, and refresh flows to avoid duplicated discovery logic.
 */
export async function discoverOAuthEndpoints(
  oauthConfig: {
    server_url: string;
    supports_resource_metadata: boolean;
    auth_server_url?: string;
    authorization_endpoint?: string;
    resource_metadata_url?: string;
    well_known_url?: string;
    token_endpoint?: string;
  },
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
): Promise<DiscoveredEndpoints> {
  const explicitEndpoints = getExplicitOAuthEndpoints(oauthConfig);
  let discoveryServerUrl =
    oauthConfig.auth_server_url || oauthConfig.server_url;
  const shouldDiscoverResourceMetadata =
    oauthConfig.supports_resource_metadata &&
    (!oauthConfig.auth_server_url || !!oauthConfig.resource_metadata_url);

  if (shouldDiscoverResourceMetadata) {
    try {
      log?.info(
        { serverUrl: oauthConfig.server_url },
        "Discovering resource metadata",
      );
      const resourceMetadata = await discoverOAuthResourceMetadata(
        oauthConfig.server_url,
        {
          resourceMetadataUrl: oauthConfig.resource_metadata_url,
        },
      );
      if (
        !oauthConfig.auth_server_url &&
        resourceMetadata.authorization_servers &&
        Array.isArray(resourceMetadata.authorization_servers) &&
        resourceMetadata.authorization_servers.length > 0
      ) {
        discoveryServerUrl = resourceMetadata.authorization_servers[0];
        log?.info(
          { authServerUrl: discoveryServerUrl },
          "Using authorization server URL from resource metadata",
        );
      }
    } catch (error) {
      log?.warn(
        { error },
        "Resource metadata discovery failed; continuing with standard discovery",
      );
    }
  }

  try {
    const metadata = await discoverAuthorizationServerMetadataWithOverrides(
      discoveryServerUrl,
      {
        authServerUrl: oauthConfig.auth_server_url,
        resourceMetadataUrl: oauthConfig.resource_metadata_url,
        wellKnownUrl: oauthConfig.well_known_url,
      },
    );
    if (
      (explicitEndpoints.authorizationEndpoint &&
        explicitEndpoints.authorizationEndpoint !==
          metadata.authorization_endpoint) ||
      (explicitEndpoints.tokenEndpoint &&
        explicitEndpoints.tokenEndpoint !== metadata.token_endpoint)
    ) {
      log?.warn(
        {
          discoveredAuthorizationEndpoint: metadata.authorization_endpoint,
          discoveredTokenEndpoint: metadata.token_endpoint,
          authorizationEndpoint: explicitEndpoints.authorizationEndpoint,
          tokenEndpoint: explicitEndpoints.tokenEndpoint,
        },
        "Using explicitly configured OAuth endpoint overrides instead of discovered metadata",
      );
    }
    log?.info(
      {
        authorizationEndpoint:
          explicitEndpoints.authorizationEndpoint ??
          metadata.authorization_endpoint,
        tokenEndpoint:
          explicitEndpoints.tokenEndpoint ?? metadata.token_endpoint,
        registrationEndpoint: metadata.registration_endpoint,
      },
      "Discovery successful",
    );

    return {
      authorizationEndpoint:
        explicitEndpoints.authorizationEndpoint ??
        metadata.authorization_endpoint,
      tokenEndpoint: explicitEndpoints.tokenEndpoint ?? metadata.token_endpoint,
      registrationEndpoint: metadata.registration_endpoint,
    };
  } catch (error) {
    if (
      explicitEndpoints.authorizationEndpoint &&
      explicitEndpoints.tokenEndpoint
    ) {
      log?.warn(
        {
          error,
          authorizationEndpoint: explicitEndpoints.authorizationEndpoint,
          tokenEndpoint: explicitEndpoints.tokenEndpoint,
        },
        "Authorization server discovery failed; using explicitly configured OAuth endpoints",
      );
      return {
        authorizationEndpoint: explicitEndpoints.authorizationEndpoint,
        tokenEndpoint: explicitEndpoints.tokenEndpoint,
      };
    }

    throw error;
  }
}

/**
 * Perform dynamic client registration (RFC 7591)
 */
async function registerOAuthClient(
  registrationEndpoint: string,
  clientMetadata: {
    client_name: string;
    redirect_uris: string[];
    grant_types?: string[];
    response_types?: string[];
    scope?: string;
  },
) {
  try {
    const response = await fetch(registrationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(clientMetadata),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Client registration failed: ${response.status} ${errorText}`,
      );
    }

    const result = await response.json();
    logger.info(
      { registrationResult: result },
      "registerOAuthClient: Dynamic client registration response",
    );
    return result;
  } catch (error) {
    throw new Error(
      `Dynamic client registration failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * OAuth state data stored in cache during the OAuth flow.
 */
interface OAuthStateData {
  catalogId: string;
  codeVerifier: string;
  clientId?: string;
  clientSecret?: string;
  registrationResult?: Record<string, unknown>;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Generate cache key for OAuth state
 */
function getOAuthStateCacheKey(
  state: string,
): `${typeof CacheKey.OAuthState}-${string}` {
  return `${CacheKey.OAuthState}-${state}`;
}

/**
 * Store OAuth state in cache
 */
async function setOAuthState(
  state: string,
  data: OAuthStateData,
): Promise<void> {
  await cacheManager.set(
    getOAuthStateCacheKey(state),
    data,
    OAUTH_STATE_TTL_MS,
  );
}

/**
 * Atomically retrieve and delete OAuth state from cache.
 * Uses cacheManager.getAndDelete() to prevent race conditions where
 * the same state could be used twice if two requests arrive simultaneously.
 */
async function getAndDeleteOAuthState(
  state: string,
): Promise<OAuthStateData | null> {
  const key = getOAuthStateCacheKey(state);
  const data = await cacheManager.getAndDelete<OAuthStateData>(key);
  return data ?? null;
}

/**
 * Outcome of an OAuth refresh attempt. A `terminal` failure means the grant is
 * dead (re-authentication required); a `transient` failure is a recoverable
 * transport/infrastructure blip that must not change persisted connection
 * health and is re-attempted on next use.
 */
export type OAuthRefreshOutcome =
  | { ok: true }
  | {
      ok: false;
      kind: "terminal";
      category: "refresh_failed" | "no_refresh_token";
      message: string;
    }
  | {
      ok: false;
      kind: "transient";
      reason:
        | "network"
        | "timeout"
        | "server_error"
        | "rate_limited"
        | "unexpected_response";
    };

const OAUTH_TOKEN_REFRESH_TIMEOUT_MS = 30_000;

// An OAuth `error` code is a restricted ASCII token (RFC 6749 §5.2). Anything
// outside this shape (URLs, free text, token material) is dropped.
const OAUTH_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export function sanitizeOAuthErrorCode(error?: string | null): string {
  if (typeof error === "string" && OAUTH_ERROR_CODE_PATTERN.test(error)) {
    return error;
  }
  return "refresh_failed";
}

// OAuth error codes that signal a temporary server condition, not a dead grant
// (RFC 6749 §4.1.2.1). Some authorization servers return these on a 400.
const TRANSIENT_OAUTH_ERRORS = new Set([
  "temporarily_unavailable",
  "server_error",
]);

/**
 * Classify a token-endpoint response. A genuine grant rejection is a structured
 * OAuth `error` body, which is terminal — but infrastructure failures
 * (5xx, 429, or a transient OAuth error code) take precedence over the body so
 * a temporary outage is not mistaken for a revoked grant. A proxy/WAF 4xx or a
 * captive-portal 200 with no token are likewise transient, not "re-authenticate".
 */
export function classifyRefreshResponse(params: {
  status: number;
  body: {
    access_token?: string;
    error?: string;
    error_description?: string;
  } | null;
}): OAuthRefreshOutcome {
  const { status, body } = params;

  if (status >= 200 && status < 300 && body?.access_token) {
    return { ok: true };
  }

  if (status >= 500) {
    return { ok: false, kind: "transient", reason: "server_error" };
  }
  if (status === 429) {
    return { ok: false, kind: "transient", reason: "rate_limited" };
  }
  if (body?.error && TRANSIENT_OAUTH_ERRORS.has(body.error)) {
    return { ok: false, kind: "transient", reason: "server_error" };
  }

  if (body?.error) {
    return {
      ok: false,
      kind: "terminal",
      category: "refresh_failed",
      message: sanitizeOAuthErrorCode(body.error),
    };
  }

  return { ok: false, kind: "transient", reason: "unexpected_response" };
}

export function classifyThrownRefreshError(
  error: unknown,
): Extract<OAuthRefreshOutcome, { kind: "transient" }> {
  const isTimeout =
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError");
  return {
    ok: false,
    kind: "transient",
    reason: isTimeout ? "timeout" : "network",
  };
}

/**
 * Map a refresh outcome to the `mcp_server` fields to persist. Returns `null`
 * for success and for transient failures (which must persist nothing).
 */
export function refreshFailureToServerFields(outcome: OAuthRefreshOutcome): {
  oauthRefreshError: "refresh_failed" | "no_refresh_token";
  oauthRefreshErrorMessage: string;
  oauthRefreshFailedAt: Date;
} | null {
  if (outcome.ok || outcome.kind !== "terminal") {
    return null;
  }
  return {
    oauthRefreshError: outcome.category,
    oauthRefreshErrorMessage: outcome.message,
    oauthRefreshFailedAt: new Date(),
  };
}

/**
 * Refresh an OAuth access token using the stored refresh token, called when an
 * access token is expired or about to expire.
 *
 * @param secretId - The ID of the secret containing the OAuth tokens
 * @param catalogId - The ID of the catalog item (MCP server) for OAuth config
 */
export async function refreshOAuthToken(
  secretId: string,
  catalogId: string,
): Promise<OAuthRefreshOutcome> {
  try {
    const secret = await secretManager().getSecret(secretId);
    if (!secret?.secret) {
      logger.warn({ secretId }, "refreshOAuthToken: Secret not found");
      return {
        ok: false,
        kind: "terminal",
        category: "refresh_failed",
        message: "refresh_failed",
      };
    }

    const currentTokens = secret.secret as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      expires_at?: number;
      token_type?: string;
      // When using dynamic oauth client registration (for example huggingace mcp), store the client credentials in the secret
      // to be able to refresh the token.
      client_id?: string;
      client_secret?: string;
    };

    if (!currentTokens.refresh_token) {
      logger.warn(
        { secretId },
        "refreshOAuthToken: No refresh token available",
      );
      return {
        ok: false,
        kind: "terminal",
        category: "no_refresh_token",
        message: "no_refresh_token",
      };
    }

    // Get catalog item with OAuth configuration
    const catalogItem =
      await InternalMcpCatalogModel.findByIdWithResolvedSecrets(catalogId);
    if (!catalogItem?.oauthConfig) {
      logger.warn(
        { catalogId },
        "refreshOAuthToken: Catalog item or OAuth config not found",
      );
      return {
        ok: false,
        kind: "terminal",
        category: "refresh_failed",
        message: "refresh_failed",
      };
    }

    const oauthConfig = catalogItem.oauthConfig;

    // Discover token endpoint
    let tokenEndpoint: string;
    try {
      const endpoints = await discoverOAuthEndpoints(oauthConfig);
      tokenEndpoint = endpoints.tokenEndpoint;
    } catch {
      // Fallback to config or constructed endpoint
      tokenEndpoint =
        oauthConfig.token_endpoint || `${oauthConfig.server_url}/token`;
    }

    // Use client credentials from OAuth config first (source of truth),
    // fall back to stored values (for dynamic client registration cases)
    const clientId = oauthConfig.client_id || currentTokens.client_id;
    const clientSecret =
      oauthConfig.client_secret || currentTokens.client_secret;

    if (!clientId) {
      logger.warn(
        { secretId, catalogId },
        "refreshOAuthToken: No client_id available for token refresh",
      );
      return {
        ok: false,
        kind: "terminal",
        category: "refresh_failed",
        message: "refresh_failed",
      };
    }

    const oauthResource = getOAuthTokenResource(oauthConfig);
    logger.info(
      {
        secretId,
        catalogId,
        tokenEndpoint,
        hasStoredClientId: !!currentTokens.client_id,
        hasConfigClientId: !!oauthConfig.client_id,
        usingClientId: clientId ? `${clientId.substring(0, 8)}...` : "(empty)",
      },
      "refreshOAuthToken: Attempting token refresh",
    );

    // Exchange refresh token for new access token
    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: currentTokens.refresh_token,
        client_id: clientId,
        ...(clientSecret && {
          client_secret: clientSecret,
        }),
        ...(oauthResource && {
          resource: oauthResource,
        }),
      }),
      signal: AbortSignal.timeout(OAUTH_TOKEN_REFRESH_TIMEOUT_MS),
    });

    // Parse the body once. A non-JSON body (proxy/WAF/captive-portal HTML)
    // leaves `body` null, which classifyRefreshResponse treats as transient.
    const rawBody = await tokenResponse.text();
    let body: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    } | null = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }

    const outcome = classifyRefreshResponse({
      status: tokenResponse.status,
      body,
    });

    if (!outcome.ok) {
      // Never log the raw body — it may carry token material.
      logger.error(
        {
          secretId,
          catalogId,
          status: tokenResponse.status,
          classification: outcome.kind,
          reason:
            outcome.kind === "terminal" ? outcome.message : outcome.reason,
        },
        "refreshOAuthToken: Token refresh did not succeed",
      );
      return outcome;
    }

    // classifyRefreshResponse only returns ok for a 2xx body with an access token.
    const tokenData = body as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    // Store entire OAuth response to preserve provider-specific fields (scope, id_token, etc.)
    const updatedSecretPayload = {
      ...currentTokens,
      ...tokenData,
      // Use new refresh token if provided, otherwise keep the old one
      refresh_token: tokenData.refresh_token || currentTokens.refresh_token,
      // Add computed expiration timestamp for reliable expiration checking
      ...(tokenData.expires_in && {
        expires_at: Date.now() + tokenData.expires_in * 1000,
      }),
      // Store client credentials for token refresh (config takes precedence, fallback to stored)
      ...(clientId && { client_id: clientId }),
      ...(clientSecret && { client_secret: clientSecret }),
    };

    // Persist the refreshed tokens. The grant already succeeded and a rotating
    // server has now spent the old refresh token, so a persistence failure is
    // terminal — re-authentication is the only recovery, and treating it as a
    // transient retry would silently lose the only valid refresh token.
    try {
      await secretManager().updateSecret(secretId, updatedSecretPayload);
    } catch (persistError) {
      logger.error(
        {
          secretId,
          catalogId,
          error:
            persistError instanceof Error
              ? persistError.message
              : String(persistError),
        },
        "refreshOAuthToken: refreshed token could not be persisted",
      );
      return {
        ok: false,
        kind: "terminal",
        category: "refresh_failed",
        message: "refresh_failed",
      };
    }

    logger.info(
      {
        secretId,
        catalogId,
        hasNewRefreshToken: !!tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
      },
      "refreshOAuthToken: Token refresh successful",
    );

    return { ok: true };
  } catch (error) {
    const outcome = classifyThrownRefreshError(error);
    logger.error(
      {
        secretId,
        catalogId,
        classification: outcome.kind,
        reason: outcome.kind === "transient" ? outcome.reason : undefined,
        error: error instanceof Error ? error.message : String(error),
      },
      "refreshOAuthToken: Unexpected error during token refresh",
    );
    return outcome;
  }
}

const oauthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Initiate OAuth flow for an MCP server
   * Returns the authorization URL to redirect the user to
   */
  fastify.post(
    "/api/oauth/initiate",
    {
      schema: {
        operationId: RouteId.InitiateOAuth,
        description: "Initiate OAuth flow for MCP server installation",
        tags: ["OAuth"],
        body: z.object({
          catalogId: UuidIdSchema,
          serverId: UuidIdSchema.optional(), // Optional: if server already exists
        }),
        response: constructResponseSchema(
          z.object({
            authorizationUrl: z.string().url(),
            state: z.string(),
          }),
        ),
      },
    },
    async ({ body: { catalogId }, organizationId }, reply) => {
      // Get catalog item to retrieve OAuth configuration (with resolved secrets for runtime)
      const catalogItem =
        await InternalMcpCatalogModel.findByIdWithResolvedSecrets(catalogId);

      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      if (!catalogItem.oauthConfig) {
        throw new ApiError(400, "This server does not support OAuth");
      }

      const oauthConfig = catalogItem.oauthConfig;

      // Use the redirect URI stored in the catalog (set by frontend based on window.location.origin)
      // This ensures the redirect URI matches where the user initiated the OAuth flow from
      const redirectUri = oauthConfig.redirect_uris[0];
      if (isSsoCallbackRedirectUri(redirectUri)) {
        throw new ApiError(
          400,
          "MCP OAuth redirect URI must use /oauth-callback, not the SSO callback URL.",
        );
      }

      let clientId = oauthConfig.client_id;
      let clientSecret = oauthConfig.client_secret;

      logger.info(
        {
          catalogId: catalogItem.id,
          hasClientSecret: !!clientSecret,
        },
        "OAuth init - using client_secret",
      );

      // Discover actual scopes from the OAuth server (like desktop app does)
      const { configuredScopes, discoveredScopes, scopesToUse } =
        await resolveOAuthScopesForAuthorization({
          oauthConfig,
        });

      fastify.log.info(
        {
          configured: configuredScopes,
          discovered: discoveredScopes,
          used: scopesToUse,
        },
        "Resolved OAuth scopes",
      );

      // Check if dynamic registration is needed
      if (!clientId) {
        fastify.log.info(
          "Client ID is empty, checking for cached credentials or performing dynamic registration",
        );
      }

      // Discover authorization server metadata to get the correct authorization endpoint
      let authorizationEndpoint: string;
      let registrationEndpoint: string | undefined;

      // For proxy servers, skip discovery and use the MCP server URL directly
      if (oauthConfig.requires_proxy) {
        fastify.log.info(
          { serverUrl: oauthConfig.server_url },
          "Server requires proxy, using MCP server URL as OAuth server",
        );
        // GitHub Copilot MCP uses /mcp/oauth/authorize
        authorizationEndpoint = `${oauthConfig.server_url}/oauth/authorize`;
        // Proxy servers typically don't support dynamic registration
        registrationEndpoint = undefined;
      } else {
        try {
          const endpoints = await discoverOAuthEndpoints(
            oauthConfig,
            fastify.log,
          );
          authorizationEndpoint = endpoints.authorizationEndpoint;
          registrationEndpoint = endpoints.registrationEndpoint;
        } catch (error) {
          fastify.log.error({ error }, "Authorization server discovery failed");
          throw new ApiError(500, "Failed to discover OAuth endpoints");
        }
      }

      // If we don't have client credentials and registration endpoint is available, try dynamic registration
      let registrationResult: Record<string, unknown> | undefined;
      if (!clientId && registrationEndpoint) {
        try {
          fastify.log.info(
            { registrationEndpoint },
            "Attempting dynamic client registration",
          );
          registrationResult = await registerOAuthClient(registrationEndpoint, {
            client_name: `${await resolveOAuthClientBrandName(organizationId)} - ${catalogItem.name}`,
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope: scopesToUse.join(" "),
          });

          clientId = registrationResult?.client_id as string;
          clientSecret = registrationResult?.client_secret as
            | string
            | undefined;

          fastify.log.info(
            { client_id: clientId },
            "Dynamic registration successful",
          );
        } catch (error) {
          fastify.log.warn(
            {
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            "Dynamic registration failed, continuing with default client_id",
          );
          // Continue with default client_id if registration fails
        }
      }

      // Ensure we have a usable client ID (either static or from dynamic registration)
      if (!clientId) {
        throw new ApiError(
          400,
          "No client ID available. Configure a client_id in the catalog item or ensure the OAuth server supports dynamic client registration.",
        );
      }

      // Generate PKCE parameters
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = randomBytes(16).toString("base64url");

      // Store state temporarily (will be used in callback)
      await setOAuthState(state, {
        catalogId,
        codeVerifier,
        clientId,
        clientSecret,
        registrationResult,
      });

      // Build authorization URL using the discovered authorization endpoint
      const authUrl = new URL(authorizationEndpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("scope", scopesToUse.join(" "));
      authUrl.searchParams.set("redirect_uri", redirectUri);

      // RFC 8707: Include resource parameter for audience binding
      // Required by MCP servers like Windmill that need to know which
      // protected resource the token is intended for
      const oauthResource = getOAuthResource(oauthConfig);
      if (oauthResource) {
        authUrl.searchParams.set("resource", oauthResource);
      }

      return reply.send({
        authorizationUrl: authUrl.toString(),
        state,
      });
    },
  );

  /**
   * Handle OAuth callback
   * Exchanges authorization code for access token
   */
  fastify.post(
    "/api/oauth/callback",
    {
      schema: {
        operationId: RouteId.HandleOAuthCallback,
        description: "Handle OAuth callback and exchange code for tokens",
        tags: ["OAuth"],
        body: z.object({
          code: z.string(),
          state: z.string(),
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            catalogId: UuidIdSchema,
            name: z.string(),
            accessToken: z.string(),
            refreshToken: z.string().optional(),
            expiresIn: z.number().optional(),
            secretId: UuidIdSchema,
          }),
        ),
      },
    },
    async ({ body: { code, state } }, reply) => {
      // Retrieve OAuth state (also deletes it to prevent replay attacks)
      const oauthState = await getAndDeleteOAuthState(state);
      if (!oauthState) {
        throw new ApiError(400, "Invalid or expired OAuth state");
      }

      // Get catalog item to retrieve OAuth configuration (with resolved secrets for runtime)
      const catalogItem =
        await InternalMcpCatalogModel.findByIdWithResolvedSecrets(
          oauthState.catalogId,
        );

      if (!catalogItem || !catalogItem.oauthConfig) {
        throw new ApiError(400, "Invalid catalog item or OAuth configuration");
      }

      const oauthConfig = catalogItem.oauthConfig;

      // Use client credentials from state (dynamically registered) or fall back to config
      const clientId = oauthState.clientId || oauthConfig.client_id;
      const clientSecret = oauthState.clientSecret || oauthConfig.client_secret;

      // Use the same redirect URI that was registered during initiation
      // This must match exactly what was used in the authorization request
      const redirectUri = oauthConfig.redirect_uris[0];
      let tokenData: {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };

      // For proxy servers, use MCP SDK's exchangeAuthorization function
      if (oauthConfig.requires_proxy) {
        fastify.log.info(
          { serverUrl: oauthConfig.server_url },
          "Server requires proxy, using MCP SDK exchangeAuthorization",
        );

        try {
          // Use MCP SDK's exchangeAuthorization - it handles all discovery and authentication
          const oauthResourceUrl = getOAuthResourceUrl(oauthConfig);
          const tokens = await exchangeAuthorization(oauthConfig.server_url, {
            clientInformation: {
              client_id: clientId,
              client_secret: clientSecret,
            },
            authorizationCode: code,
            codeVerifier: oauthState.codeVerifier,
            redirectUri,
            resource: oauthResourceUrl,
          });

          fastify.log.info("MCP SDK token exchange successful");
          tokenData = tokens;
        } catch (error) {
          fastify.log.error({ error }, "MCP SDK token exchange failed");

          throw new ApiError(
            400,
            `Failed to exchange authorization code: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        }
      } else {
        // For non-proxy servers, use standard OAuth token exchange
        let tokenEndpoint: string;
        try {
          const endpoints = await discoverOAuthEndpoints(
            oauthConfig,
            fastify.log,
          );
          tokenEndpoint = endpoints.tokenEndpoint;
        } catch (error) {
          fastify.log.error(
            { error },
            "Token endpoint discovery failed, using fallback",
          );
          // Fallback to config or constructed endpoint
          tokenEndpoint =
            oauthConfig.token_endpoint || `${oauthConfig.server_url}/token`;
        }

        const oauthResource = getOAuthTokenResource(oauthConfig);
        const tokenResponse = await fetch(tokenEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: oauthState.codeVerifier,
            ...(clientSecret && {
              client_secret: clientSecret,
            }),
            ...(oauthResource && {
              resource: oauthResource,
            }),
          }),
        });

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text();
          fastify.log.error(
            `Token exchange failed: ${tokenResponse.status} ${errorText}`,
          );

          throw new ApiError(
            400,
            `Failed to exchange authorization code: ${errorText}`,
          );
        }

        tokenData = await tokenResponse.json();
      }

      // Log the token data to help debug issues
      logger.info(
        {
          hasAccessToken: !!tokenData.access_token,
          hasRefreshToken: !!tokenData.refresh_token,
          hasExpiresIn: !!tokenData.expires_in,
          tokenDataKeys: Object.keys(tokenData),
        },
        "OAuth callback: received token data",
      );

      // Validate that we actually received an access token
      // Some OAuth providers return 200 with error in body, or MCP SDK might return error object
      if (!tokenData.access_token) {
        // Cast to unknown first to access potential error fields
        const errorData = tokenData as unknown as {
          error?: string;
          error_description?: string;
        };
        const errorMsg =
          errorData.error_description ||
          errorData.error ||
          "No access token received";
        logger.error(
          {
            tokenDataKeys: Object.keys(tokenData),
            error: errorData.error,
            errorDescription: errorData.error_description,
          },
          "OAuth callback: token exchange did not return access_token",
        );
        throw new ApiError(400, `OAuth token exchange failed: ${errorMsg}`);
      }

      // Create secret entry with the OAuth tokens
      // Use forceDB=true when BYOS is enabled because OAuth tokens are generated values,
      // not user-provided vault references
      // Store entire OAuth response to preserve provider-specific fields (scope, id_token, etc.)
      const secretPayload = {
        ...tokenData,
        // Add computed expiration timestamp for reliable expiration checking
        ...(tokenData.expires_in && {
          expires_at: Date.now() + tokenData.expires_in * 1000,
        }),
        // Store client credentials for token refresh (may come from dynamic registration)
        ...(clientId && { client_id: clientId }),
        ...(clientSecret && { client_secret: clientSecret }),
      };

      logger.info(
        {
          secretPayloadKeys: Object.keys(secretPayload),
          isByosEnabled: isByosEnabled(),
        },
        "OAuth callback: creating secret with payload",
      );

      const secret = await secretManager().createSecret(
        secretPayload,
        `${catalogItem.name}-oauth`,
        isByosEnabled(), // forceDB: store in DB when BYOS is enabled
      );

      return reply.send({
        success: true,
        catalogId: oauthState.catalogId,
        name: catalogItem.name,
        accessToken: tokenData.access_token,
        // Only include optional fields if they have truthy values (avoid null which fails schema validation)
        ...(tokenData.refresh_token && {
          refreshToken: tokenData.refresh_token,
        }),
        ...(tokenData.expires_in && { expiresIn: tokenData.expires_in }),
        secretId: secret.id,
      });
    },
  );
};

function getExplicitOAuthEndpoints(oauthConfig: {
  authorization_endpoint?: string;
  token_endpoint?: string;
}): ExplicitOAuthEndpoints {
  return {
    authorizationEndpoint: oauthConfig.authorization_endpoint,
    tokenEndpoint: oauthConfig.token_endpoint,
  };
}

function isSsoCallbackRedirectUri(redirectUri: string | undefined): boolean {
  if (!redirectUri) {
    return false;
  }

  try {
    return new URL(redirectUri).pathname.startsWith("/api/auth/sso/callback");
  } catch {
    return redirectUri.includes("/api/auth/sso/callback");
  }
}

export function getOAuthResource(oauthConfig: {
  audience?: string;
  resource?: string;
  server_url?: string;
}): string | undefined {
  // Prefer the explicit RFC 8707 resource, then legacy audience configs.
  // Do not fall back to server_url for authorization-code flows: some providers
  // reject unexpected resource indicators when exchanging the authorization code.
  return oauthConfig.resource || oauthConfig.audience;
}

export function getOAuthTokenResource(oauthConfig: {
  audience?: string;
  resource?: string;
}): string | undefined {
  return getOAuthResource(oauthConfig);
}

export function getOAuthResourceUrl(oauthConfig: {
  audience?: string;
  resource?: string;
  server_url?: string;
}): URL {
  if (oauthConfig.resource) {
    return parseOAuthResourceUrl(oauthConfig.resource);
  }

  if (oauthConfig.audience) {
    const audienceUrl = tryParseOAuthResourceUrl(oauthConfig.audience);
    if (audienceUrl) {
      return audienceUrl;
    }
  }

  if (oauthConfig.server_url) {
    return parseOAuthResourceUrl(oauthConfig.server_url);
  }

  throw new ApiError(400, "OAuth resource is not configured");
}

function parseOAuthResourceUrl(oauthResource: string): URL {
  const resourceUrl = tryParseOAuthResourceUrl(oauthResource);
  if (!resourceUrl) {
    throw new ApiError(
      400,
      `Invalid OAuth resource URL: ${oauthResource}. Use a full URI such as https://api.example.com or api://client-id.`,
    );
  }

  return resourceUrl;
}

function tryParseOAuthResourceUrl(oauthResource: string): URL | null {
  try {
    return new URL(oauthResource);
  } catch {
    return null;
  }
}

/**
 * Resolve the brand name used as the OAuth client name during dynamic client
 * registration. This is the name remote MCP servers surface in their consent
 * screens (e.g. "Archestra Platform - Atlassian Cloud MCP"). When enterprise
 * full white-labeling is active and the organization has configured an app
 * name, that name is used instead so the consent flow reflects the deployment's
 * own branding. Falls back to the default product name otherwise.
 */
async function resolveOAuthClientBrandName(
  organizationId: string,
): Promise<string> {
  const defaultBrandName = `${DEFAULT_APP_NAME} Platform`;

  if (!config.enterpriseFeatures.fullWhiteLabeling) {
    return defaultBrandName;
  }

  const organization = await OrganizationModel.getById(organizationId);
  const appName = organization?.appName?.trim();
  return appName || defaultBrandName;
}

export default oauthRoutes;
