import { createHash, randomBytes } from "node:crypto";
import { exchangeAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { InternalMcpCatalogModel } from "@/models";
import { isByosEnabled, secretManager } from "@/secrets-manager";
import { ApiError, constructResponseSchema, UuidIdSchema } from "@/types";

/**
 * Generate PKCE code verifier
 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Generate PKCE code challenge from verifier
 */
function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Discover OAuth resource metadata (for MCP servers)
 * Sends MCP-Protocol-Version header for MCP-aware servers
 */
async function discoverOAuthResourceMetadata(serverUrl: string) {
  try {
    // MCP SDK uses "path-aware discovery": /.well-known/{type}{pathname}
    // For https://huggingface.co/mcp -> https://huggingface.co/.well-known/oauth-protected-resource/mcp
    const url = new URL(serverUrl);
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    const wellKnownUrl = `${url.origin}/.well-known/oauth-protected-resource${pathname}`;

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
async function discoverScopes(
  serverUrl: string,
  supportsResourceMetadata: boolean,
  defaultScopes: string[],
): Promise<string[]> {
  // Try resource metadata discovery first if supported
  if (supportsResourceMetadata) {
    try {
      const resourceMetadata = await discoverOAuthResourceMetadata(serverUrl);
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
    const metadata = await discoverAuthorizationServerMetadata(serverUrl);
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

/**
 * Build discovery URLs to try for authorization server metadata
 * Implements the same fallback strategy as MCP SDK
 */
function buildDiscoveryUrls(serverUrl: string): string[] {
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
async function discoverAuthorizationServerMetadata(serverUrl: string): Promise<{
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}> {
  const urls = buildDiscoveryUrls(serverUrl);

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
 * Refresh an OAuth access token using the stored refresh token.
 * This function is called when an access token is expired or about to expire.
 *
 * @param secretId - The ID of the secret containing the OAuth tokens
 * @param catalogId - The ID of the catalog item (MCP server) for OAuth config
 * @returns true if refresh was successful, false otherwise
 */
export async function refreshOAuthToken(
  secretId: string,
  catalogId: string,
): Promise<boolean> {
  try {
    const secret = await secretManager().getSecret(secretId);
    if (!secret?.secret) {
      logger.warn({ secretId }, "refreshOAuthToken: Secret not found");
      return false;
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
      return false;
    }

    // Get catalog item with OAuth configuration
    const catalogItem =
      await InternalMcpCatalogModel.findByIdWithResolvedSecrets(catalogId);
    if (!catalogItem?.oauthConfig) {
      logger.warn(
        { catalogId },
        "refreshOAuthToken: Catalog item or OAuth config not found",
      );
      return false;
    }

    const oauthConfig = catalogItem.oauthConfig;

    // Discover token endpoint
    let tokenEndpoint: string;
    let discoveryServerUrl = oauthConfig.server_url;

    // Try resource metadata discovery first if supported
    if (oauthConfig.supports_resource_metadata) {
      try {
        const resourceMetadata = await discoverOAuthResourceMetadata(
          oauthConfig.server_url,
        );
        if (
          resourceMetadata.authorization_servers &&
          Array.isArray(resourceMetadata.authorization_servers) &&
          resourceMetadata.authorization_servers.length > 0
        ) {
          discoveryServerUrl = resourceMetadata.authorization_servers[0];
        }
      } catch {
        // Continue with standard discovery
      }
    }

    try {
      const metadata =
        await discoverAuthorizationServerMetadata(discoveryServerUrl);
      tokenEndpoint = metadata.token_endpoint;
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
      return false;
    }

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
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.error(
        { secretId, status: tokenResponse.status, error: errorText },
        "refreshOAuthToken: Token refresh request failed",
      );
      return false;
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!tokenData.access_token) {
      logger.error(
        {
          secretId,
          error: tokenData.error,
          errorDescription: tokenData.error_description,
        },
        "refreshOAuthToken: No access token in refresh response",
      );
      return false;
    }

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

    // Update the secret in storage
    await secretManager().updateSecret(secretId, updatedSecretPayload);

    logger.info(
      {
        secretId,
        catalogId,
        hasNewRefreshToken: !!tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
      },
      "refreshOAuthToken: Token refresh successful",
    );

    return true;
  } catch (error) {
    logger.error(
      {
        secretId,
        catalogId,
        error: error instanceof Error ? error.message : String(error),
      },
      "refreshOAuthToken: Unexpected error during token refresh",
    );
    return false;
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
    async ({ body: { catalogId } }, reply) => {
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
      const discoveredScopes = await discoverScopes(
        oauthConfig.server_url,
        oauthConfig.supports_resource_metadata || false,
        oauthConfig.default_scopes || oauthConfig.scopes,
      );

      // Use discovered scopes if different from configured
      const scopesToUse =
        JSON.stringify(discoveredScopes.sort()) !==
        JSON.stringify(oauthConfig.scopes.sort())
          ? discoveredScopes
          : oauthConfig.scopes;

      if (scopesToUse !== oauthConfig.scopes) {
        fastify.log.info(
          {
            configured: oauthConfig.scopes,
            discovered: scopesToUse,
          },
          "Using discovered scopes instead of configured scopes",
        );
      }

      // Check if dynamic registration is needed
      if (!clientId) {
        fastify.log.info(
          "Client ID is empty, checking for cached credentials or performing dynamic registration",
        );
      }

      // Discover authorization server metadata to get the correct authorization endpoint
      let authorizationEndpoint: string;
      let registrationEndpoint: string | undefined;
      let discoveryServerUrl = oauthConfig.server_url;

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
        // Try resource metadata discovery first, but treat failures as non-fatal
        if (oauthConfig.supports_resource_metadata) {
          try {
            fastify.log.info(
              { serverUrl: oauthConfig.server_url },
              "Server supports resource metadata, discovering resource metadata first",
            );
            const resourceMetadata = await discoverOAuthResourceMetadata(
              oauthConfig.server_url,
            );

            // Extract authorization server URL from resource metadata
            // RFC 8414: authorization_servers is an array of issuer URLs
            if (
              resourceMetadata.authorization_servers &&
              Array.isArray(resourceMetadata.authorization_servers) &&
              resourceMetadata.authorization_servers.length > 0
            ) {
              discoveryServerUrl = resourceMetadata.authorization_servers[0];
              fastify.log.info(
                { authServerUrl: discoveryServerUrl },
                "Using authorization server URL from resource metadata",
              );
            }
          } catch (error) {
            // Some servers require auth to access resource metadata (may return 401).
            // Log and continue with standard authorization server discovery.
            fastify.log.warn(
              { error },
              "Resource metadata discovery failed; continuing with standard discovery",
            );
          }
        }

        try {
          fastify.log.info(
            { serverUrl: discoveryServerUrl },
            "Discovering authorization server metadata",
          );
          const metadata =
            await discoverAuthorizationServerMetadata(discoveryServerUrl);
          authorizationEndpoint = metadata.authorization_endpoint;
          registrationEndpoint = metadata.registration_endpoint;
          fastify.log.info(
            {
              authorizationEndpoint,
              tokenEndpoint: metadata.token_endpoint,
              registrationEndpoint,
            },
            "Discovery successful",
          );
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
            client_name: `Archestra Platform - ${catalogItem.name}`,
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
          const tokens = await exchangeAuthorization(oauthConfig.server_url, {
            clientInformation: {
              client_id: clientId,
              client_secret: clientSecret,
            },
            authorizationCode: code,
            codeVerifier: oauthState.codeVerifier,
            redirectUri,
            // For GitHub Copilot, pass the MCP server URL as resource
            resource: new URL(oauthConfig.server_url),
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
        let discoveryServerUrl = oauthConfig.server_url;

        try {
          // Try resource metadata discovery first, but treat failures as non-fatal
          if (oauthConfig.supports_resource_metadata) {
            try {
              fastify.log.info(
                { serverUrl: oauthConfig.server_url },
                "Server supports resource metadata, discovering resource metadata first",
              );
              const resourceMetadata = await discoverOAuthResourceMetadata(
                oauthConfig.server_url,
              );

              // Extract authorization server URL from resource metadata
              if (
                resourceMetadata.authorization_servers &&
                Array.isArray(resourceMetadata.authorization_servers) &&
                resourceMetadata.authorization_servers.length > 0
              ) {
                discoveryServerUrl = resourceMetadata.authorization_servers[0];
                fastify.log.info(
                  { authServerUrl: discoveryServerUrl },
                  "Using authorization server URL from resource metadata",
                );
              }
            } catch (error) {
              fastify.log.warn(
                { error },
                "Resource metadata discovery failed; continuing with standard discovery",
              );
            }
          }

          const metadata =
            await discoverAuthorizationServerMetadata(discoveryServerUrl);
          tokenEndpoint = metadata.token_endpoint;
          fastify.log.info(
            { tokenEndpoint },
            "Discovered token endpoint for callback",
          );
        } catch (error) {
          fastify.log.error(
            { error },
            "Token endpoint discovery failed, using fallback",
          );
          // Fallback to config or constructed endpoint
          tokenEndpoint =
            oauthConfig.token_endpoint || `${oauthConfig.server_url}/token`;
        }

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

export default oauthRoutes;
