import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_TOOL_PREFIX,
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  OAUTH_TOKEN_ID_PREFIX,
  parseFullToolName,
} from "@shared";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  executeArchestraTool,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import { userHasPermission } from "@/auth/utils";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import db, { schema as dbSchema } from "@/database";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  McpToolCallModel,
  MemberModel,
  OAuthAccessTokenModel,
  TeamModel,
  TeamTokenModel,
  ToolModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import { metrics } from "@/observability";
import { startActiveMcpSpan } from "@/routes/proxy/utils/tracing";
import { jwksValidator } from "@/services/jwks-validator";
import { type CommonToolCall, UuidIdSchema } from "@/types";
import { deriveAuthMethod } from "@/utils/auth-method";
import { estimateToolResultContentLength } from "@/utils/tool-result-preview";

export { deriveAuthMethod };

/**
 * Token authentication result
 */
export interface TokenAuthResult {
  tokenId: string;
  teamId: string | null;
  isOrganizationToken: boolean;
  /** Organization ID the token belongs to */
  organizationId: string;
  /** True if this is a personal user token */
  isUserToken?: boolean;
  /** User ID for user tokens */
  userId?: string;
  /** True if authenticated via external IdP JWKS */
  isExternalIdp?: boolean;
  /** Raw JWT token for propagation to underlying MCP servers */
  rawToken?: string;
}

/**
 * Create a fresh MCP server for a request
 * In stateless mode, we need to create new server instances per request
 */
type AgentInfo = {
  name: string;
  id: string;
  labels?: Array<{ key: string; value: string }>;
};

export async function createAgentServer(
  agentId: string,
  tokenAuth?: TokenAuthContext,
): Promise<{ server: Server; agent: AgentInfo }> {
  const server = new Server(
    {
      name: `archestra-agent-${agentId}`,
      version: config.api.version,
    },
    {
      capabilities: {
        tools: { listChanged: false },
      },
    },
  );

  const fetchedAgent = await AgentModel.findById(agentId);
  if (!fetchedAgent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  const agent = fetchedAgent;

  // Create a map of Archestra tool names to their titles
  // This is needed because the database schema doesn't include a title field
  const archestraTools = getArchestraMcpTools();
  const archestraToolTitles = new Map(
    archestraTools.map((tool: Tool) => [tool.name, tool.title]),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Get MCP tools (from connected MCP servers + Archestra built-in tools)
    // Excludes proxy-discovered tools
    // Fetch fresh on every request to ensure we get newly assigned tools
    const mcpTools = await ToolModel.getMcpToolsByAgent(agentId);

    const toolsList = mcpTools.map(({ name, description, parameters }) => ({
      name,
      title: archestraToolTitles.get(name) || name,
      description,
      inputSchema: parameters,
      annotations: {},
      _meta: {},
    }));

    // Log tools/list request
    try {
      await McpToolCallModel.create({
        agentId,
        mcpServerName: "mcp-gateway",
        method: "tools/list",
        toolCall: null,
        // biome-ignore lint/suspicious/noExplicitAny: toolResult structure varies by method type
        toolResult: { tools: toolsList } as any,
        userId: tokenAuth?.userId ?? null,
        authMethod: deriveAuthMethod(tokenAuth) ?? null,
      });
      logger.info(
        { agentId, toolsCount: toolsList.length },
        "✅ Saved tools/list request",
      );
    } catch (dbError) {
      logger.warn({ err: dbError }, "Failed to persist tools/list request:");
    }

    return { tools: toolsList };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }) => {
      const startTime = Date.now();
      const mcpServerName = parseFullToolName(name).serverName ?? "unknown";

      try {
        // Check if this is an Archestra tool or agent delegation tool
        const archestraToolPrefix = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`;
        const isArchestraTool = name.startsWith(archestraToolPrefix);
        const isAgentTool = name.startsWith(AGENT_TOOL_PREFIX);

        if (isArchestraTool || isAgentTool) {
          logger.info(
            {
              agentId,
              toolName: name,
              toolType: isAgentTool ? "agent-delegation" : "archestra",
            },
            isAgentTool
              ? "Agent delegation tool call received"
              : "Archestra MCP tool call received",
          );

          // Handle Archestra and agent delegation tools directly
          const response = await startActiveMcpSpan({
            toolName: name,
            mcpServerName,
            agent,
            callback: async (span) => {
              const result = await executeArchestraTool(name, args, {
                agent: { id: agent.id, name: agent.name },
                agentId: agent.id,
                organizationId: tokenAuth?.organizationId,
                tokenAuth,
              });
              span.setAttribute("mcp.is_error_result", result.isError ?? false);
              return result;
            },
          });

          const durationSeconds = (Date.now() - startTime) / 1000;
          metrics.mcp.reportMcpToolCall({
            profileName: agent.name,
            mcpServerName,
            toolName: name,
            durationSeconds,
            isError: false,
            profileLabels: agent.labels,
          });

          logger.info(
            {
              agentId,
              toolName: name,
            },
            isAgentTool
              ? "Agent delegation tool call completed"
              : "Archestra MCP tool call completed",
          );

          // Persist archestra/agent delegation tool call to database
          try {
            await McpToolCallModel.create({
              agentId,
              mcpServerName: ARCHESTRA_MCP_SERVER_NAME,
              method: "tools/call",
              toolCall: {
                id: `archestra-${Date.now()}`,
                name,
                arguments: args || {},
              },
              toolResult: response,
              userId: tokenAuth?.userId ?? null,
              authMethod: deriveAuthMethod(tokenAuth) ?? null,
            });
          } catch (dbError) {
            logger.info(
              { err: dbError },
              "Failed to persist archestra tool call",
            );
          }

          return response;
        }

        logger.info(
          {
            agentId,
            toolName: name,
            argumentKeys: args ? Object.keys(args) : [],
            argumentsSize: JSON.stringify(args || {}).length,
          },
          "MCP gateway tool call received",
        );

        // Generate a unique ID for this tool call
        const toolCallId = `mcp-call-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        // Create CommonToolCall for McpClient
        const toolCall: CommonToolCall = {
          id: toolCallId,
          name,
          arguments: args || {},
        };

        // Execute the tool call via McpClient with tracing
        const result = await startActiveMcpSpan({
          toolName: name,
          mcpServerName,
          agent,
          callback: async (span) => {
            const r = await mcpClient.executeToolCall(
              toolCall,
              agentId,
              tokenAuth,
            );
            span.setAttribute("mcp.is_error_result", r.isError ?? false);
            return r;
          },
        });

        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.mcp.reportMcpToolCall({
          profileName: agent.name,
          mcpServerName,
          toolName: name,
          durationSeconds,
          isError: result.isError ?? false,
          profileLabels: agent.labels,
        });

        const contentLength = estimateToolResultContentLength(result.content);
        logger.info(
          {
            agentId,
            toolName: name,
            resultContentLength: contentLength.length,
            resultContentLengthEstimated: contentLength.isEstimated,
            isError: result.isError,
          },
          result.isError
            ? "MCP gateway tool call completed with error result"
            : "MCP gateway tool call completed",
        );

        // Transform CommonToolResult to MCP response format
        // When isError is true, we still return the content so the LLM can see
        // the error message and potentially try a different approach
        return {
          content: Array.isArray(result.content)
            ? result.content
            : [{ type: "text", text: JSON.stringify(result.content) }],
          isError: result.isError,
        };
      } catch (error) {
        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.mcp.reportMcpToolCall({
          profileName: agent.name,
          mcpServerName,
          toolName: name,
          durationSeconds,
          isError: true,
          profileLabels: agent.labels,
        });

        if (typeof error === "object" && error !== null && "code" in error) {
          throw error; // Re-throw JSON-RPC errors
        }

        throw {
          code: -32603, // Internal error
          message: "Tool execution failed",
          data: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  logger.info({ agentId }, "MCP server instance created");
  return { server, agent };
}

/**
 * Create a stateless transport for a request
 * Each request gets a fresh transport with no session persistence
 */
export function createStatelessTransport(
  agentId: string,
): StreamableHTTPServerTransport {
  logger.info({ agentId }, "Creating stateless transport instance");

  // Create transport in stateless mode (no session persistence)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode - no sessions
    enableJsonResponse: true, // Use JSON responses instead of SSE
  });

  logger.info({ agentId }, "Stateless transport instance created");
  return transport;
}

/**
 * Extract bearer token from Authorization header
 * Returns the token string if valid, null otherwise
 */
export function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization as string | undefined;
  if (!authHeader) {
    return null;
  }

  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return tokenMatch?.[1] ?? null;
}

/**
 * Extract profile ID from URL path and token from Authorization header
 * URL format: /v1/mcp/:profileId
 */
export function extractProfileIdAndTokenFromRequest(
  request: FastifyRequest,
): { profileId: string; token: string } | null {
  const token = extractBearerToken(request);
  if (!token) {
    return null;
  }

  // Extract profile ID from URL path (last segment)
  const profileId = request.url.split("/").at(-1)?.split("?")[0];
  if (!profileId) {
    return null;
  }

  try {
    const parsedProfileId = UuidIdSchema.parse(profileId);
    return parsedProfileId ? { profileId: parsedProfileId, token } : null;
  } catch {
    return null;
  }
}

/**
 * Validate an archestra_ prefixed token for a specific profile
 * Returns token auth info if valid, null otherwise
 *
 * Validates that:
 * 1. The token is valid (exists and matches)
 * 2. The profile is accessible via this token:
 *    - Org token: profile must belong to the same organization
 *    - Team token: profile must be assigned to that team
 */
export async function validateTeamToken(
  profileId: string,
  tokenValue: string,
): Promise<TokenAuthResult | null> {
  // Validate the token itself
  const token = await TeamTokenModel.validateToken(tokenValue);
  if (!token) {
    return null;
  }

  // Check if profile is accessible via this token
  if (!token.isOrganizationToken) {
    // Team token: profile must be assigned to this team
    const profileTeamIds = await AgentTeamModel.getTeamsForAgent(profileId);
    const hasAccess = token.teamId && profileTeamIds.includes(token.teamId);
    logger.debug(
      { profileId, tokenTeamId: token.teamId, profileTeamIds, hasAccess },
      "validateTeamToken: checking team access",
    );
    if (!hasAccess) {
      logger.warn(
        { profileId, tokenTeamId: token.teamId, profileTeamIds },
        "Profile not accessible via team token",
      );
      return null;
    }
  }
  // Org token: any profile in the organization is accessible
  // (organization membership is verified in the route handler)

  return {
    tokenId: token.id,
    teamId: token.teamId,
    isOrganizationToken: token.isOrganizationToken,
    organizationId: token.organizationId,
  };
}

/**
 * Validate a user token for a specific profile
 * Returns token auth info if valid, null otherwise
 *
 * Validates that:
 * 1. The token is valid (exists and matches)
 * 2. The profile is accessible via this token:
 *    - User has profile:admin permission (can access all profiles), OR
 *    - User is a member of at least one team that the profile is assigned to
 */
export async function validateUserToken(
  profileId: string,
  tokenValue: string,
): Promise<TokenAuthResult | null> {
  // Validate the token itself
  const token = await UserTokenModel.validateToken(tokenValue);
  if (!token) {
    logger.debug(
      { profileId, tokenPrefix: tokenValue.substring(0, 14) },
      "validateUserToken: token not found in user_token table",
    );
    return null;
  }

  // Check if user has profile admin permission (can access all profiles)
  const isProfileAdmin = await userHasPermission(
    token.userId,
    token.organizationId,
    "profile",
    "admin",
  );

  if (isProfileAdmin) {
    return {
      tokenId: token.id,
      teamId: null, // User tokens aren't scoped to a single team
      isOrganizationToken: false,
      organizationId: token.organizationId,
      isUserToken: true,
      userId: token.userId,
    };
  }

  // Non-admin: user can access profile if they are a member of any team assigned to the profile
  const userTeamIds = await TeamModel.getUserTeamIds(token.userId);
  const profileTeamIds = await AgentTeamModel.getTeamsForAgent(profileId);
  const hasAccess = userTeamIds.some((teamId) =>
    profileTeamIds.includes(teamId),
  );

  if (!hasAccess) {
    logger.warn(
      { profileId, userId: token.userId, userTeamIds, profileTeamIds },
      "Profile not accessible via user token (no shared teams)",
    );
    return null;
  }

  return {
    tokenId: token.id,
    teamId: null, // User tokens aren't scoped to a single team
    isOrganizationToken: false,
    organizationId: token.organizationId,
    isUserToken: true,
    userId: token.userId,
  };
}

/**
 * Validate an OAuth access token for a specific profile.
 * Looks up the token by its SHA-256 hash in the oauth_access_token table
 * (matching better-auth's hashed token storage), then checks user access.
 *
 * Returns token auth info if valid, null otherwise.
 */
export async function validateOAuthToken(
  profileId: string,
  tokenValue: string,
): Promise<TokenAuthResult | null> {
  try {
    // Hash the token the same way better-auth stores it (SHA-256, base64url)
    const tokenHash = createHash("sha256")
      .update(tokenValue)
      .digest("base64url");

    // Look up the hashed token via the model
    const accessToken = await OAuthAccessTokenModel.getByTokenHash(tokenHash);

    if (!accessToken) {
      return null;
    }

    // Check if associated refresh token has been revoked
    if (accessToken.refreshTokenRevoked) {
      logger.debug(
        { profileId },
        "validateOAuthToken: associated refresh token is revoked",
      );
      return null;
    }

    // Check token expiry
    if (accessToken.expiresAt < new Date()) {
      logger.debug({ profileId }, "validateOAuthToken: token expired");
      return null;
    }

    const userId = accessToken.userId;
    if (!userId) {
      return null;
    }

    // Look up the user's organization membership
    const membership = await MemberModel.getFirstMembershipForUser(userId);
    if (!membership) {
      logger.warn(
        { profileId, userId },
        "validateOAuthToken: user has no organization membership",
      );
      return null;
    }

    const organizationId = membership.organizationId;

    // Check if user has profile admin permission (can access all profiles)
    const isProfileAdmin = await userHasPermission(
      userId,
      organizationId,
      "profile",
      "admin",
    );

    if (isProfileAdmin) {
      return {
        tokenId: `${OAUTH_TOKEN_ID_PREFIX}${accessToken.id}`,
        teamId: null,
        isOrganizationToken: false,
        organizationId,
        isUserToken: true,
        userId,
      };
    }

    // Non-admin: user can access profile if they are a member of any team assigned to the profile
    const userTeamIds = await TeamModel.getUserTeamIds(userId);
    const profileTeamIds = await AgentTeamModel.getTeamsForAgent(profileId);
    const hasAccess = userTeamIds.some((teamId) =>
      profileTeamIds.includes(teamId),
    );

    if (!hasAccess) {
      logger.warn(
        { profileId, userId, userTeamIds, profileTeamIds },
        "validateOAuthToken: profile not accessible via OAuth token (no shared teams)",
      );
      return null;
    }

    return {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${accessToken.id}`,
      teamId: null,
      isOrganizationToken: false,
      organizationId,
      isUserToken: true,
      userId,
    };
  } catch (error) {
    logger.debug(
      {
        profileId,
        error: error instanceof Error ? error.message : "unknown",
      },
      "validateOAuthToken: token validation failed",
    );
    return null;
  }
}

/**
 * Validate any token for a specific profile.
 * Tries external IdP JWKS first (if configured), then team/org tokens, user tokens, and OAuth tokens.
 * Returns token auth info if valid, null otherwise.
 */
export async function validateMCPGatewayToken(
  profileId: string,
  tokenValue: string,
): Promise<TokenAuthResult | null> {
  // Try external IdP JWKS validation first (if profile has an IdP configured)
  if (!tokenValue.startsWith("archestra_")) {
    const externalIdpResult = await validateExternalIdpToken(
      profileId,
      tokenValue,
    );
    if (externalIdpResult) {
      return externalIdpResult;
    }
  }

  // Try team/org token validation
  const teamTokenResult = await validateTeamToken(profileId, tokenValue);
  if (teamTokenResult) {
    return teamTokenResult;
  }

  // Then try user token validation
  const userTokenResult = await validateUserToken(profileId, tokenValue);
  if (userTokenResult) {
    return userTokenResult;
  }

  // Try OAuth token validation (for MCP clients like Open WebUI)
  if (!tokenValue.startsWith("archestra_")) {
    const oauthResult = await validateOAuthToken(profileId, tokenValue);
    if (oauthResult) {
      return oauthResult;
    }
  }

  logger.warn(
    { profileId, tokenPrefix: tokenValue.substring(0, 14) },
    "validateMCPGatewayToken: token validation failed - not found in any token table or access denied",
  );
  return null;
}

/**
 * Validate a JWT from an external Identity Provider via JWKS.
 * Only attempted when the profile has an associated SSO provider with OIDC config.
 *
 * @returns TokenAuthResult with external identity info, or null if validation fails
 */
export async function validateExternalIdpToken(
  profileId: string,
  tokenValue: string,
): Promise<TokenAuthResult | null> {
  try {
    // Look up the agent to check if it has an identity provider configured
    const agent = await AgentModel.findById(profileId);
    if (!agent?.identityProviderId) {
      return null;
    }

    // Look up the identity provider to get OIDC config
    const idpProvider = await findIdentityProviderById(
      agent.identityProviderId,
    );
    if (!idpProvider) {
      logger.warn(
        { profileId, identityProviderId: agent.identityProviderId },
        "validateExternalIdpToken: Identity provider not found",
      );
      return null;
    }

    // Only OIDC providers support JWKS validation
    if (!idpProvider.oidcConfig) {
      logger.debug(
        { profileId, identityProviderId: agent.identityProviderId },
        "validateExternalIdpToken: Identity provider has no OIDC config",
      );
      return null;
    }

    const oidcConfig = parseJsonField<OidcConfigForJwks>(
      idpProvider.oidcConfig,
    );
    if (!oidcConfig) {
      return null;
    }

    // Use the JWKS endpoint from OIDC config if available (avoids OIDC discovery
    // round-trip, and works when the issuer URL isn't reachable from the backend
    // e.g. in CI where the issuer is a NodePort URL but the backend runs in a pod).
    // Fall back to OIDC discovery from the issuer URL.
    const jwksUrl =
      oidcConfig.jwksEndpoint ?? (await discoverJwksUrl(idpProvider.issuer));
    if (!jwksUrl) {
      logger.warn(
        { profileId, issuer: idpProvider.issuer },
        "validateExternalIdpToken: could not determine JWKS URL",
      );
      return null;
    }

    // Validate the JWT
    const result = await jwksValidator.validateJwt({
      token: tokenValue,
      issuerUrl: idpProvider.issuer,
      jwksUrl,
      audience: oidcConfig.clientId ?? null,
    });

    if (!result) {
      return null;
    }

    logger.info(
      {
        profileId,
        identityProviderId: agent.identityProviderId,
        sub: result.sub,
        email: result.email,
      },
      "validateExternalIdpToken: JWT validated via external IdP JWKS",
    );

    // Match JWT email claim to an Archestra user for access control
    if (!result.email) {
      logger.warn(
        { profileId, sub: result.sub },
        "validateExternalIdpToken: JWT has no email claim, cannot match to Archestra user",
      );
      return null;
    }

    const user = await UserModel.findByEmail(result.email);
    if (!user) {
      logger.warn(
        { profileId, email: result.email },
        "validateExternalIdpToken: JWT email does not match any Archestra user",
      );
      return null;
    }

    const member = await MemberModel.getByUserId(user.id, agent.organizationId);
    if (!member) {
      logger.warn(
        { profileId, userId: user.id, email: result.email },
        "validateExternalIdpToken: user is not a member of the gateway's organization",
      );
      return null;
    }

    // Check if user has profile admin permission (can access all profiles)
    const isProfileAdmin = await userHasPermission(
      user.id,
      agent.organizationId,
      "profile",
      "admin",
    );

    if (isProfileAdmin) {
      return {
        tokenId: `external_idp:${agent.identityProviderId}:${result.sub}`,
        teamId: null,
        isOrganizationToken: false,
        organizationId: agent.organizationId,
        isUserToken: true,
        userId: user.id,
        isExternalIdp: true,
        rawToken: tokenValue,
      };
    }

    // Non-admin: user can access profile if they are a member of any team assigned to the profile
    const userTeamIds = await TeamModel.getUserTeamIds(user.id);
    const profileTeamIds = await AgentTeamModel.getTeamsForAgent(profileId);
    const hasAccess = userTeamIds.some((teamId) =>
      profileTeamIds.includes(teamId),
    );

    if (!hasAccess) {
      logger.warn(
        { profileId, userId: user.id, userTeamIds, profileTeamIds },
        "validateExternalIdpToken: profile not accessible via external IdP (no shared teams)",
      );
      return null;
    }

    return {
      tokenId: `external_idp:${agent.identityProviderId}:${result.sub}`,
      teamId: null,
      isOrganizationToken: false,
      organizationId: agent.organizationId,
      isUserToken: true,
      userId: user.id,
      isExternalIdp: true,
      rawToken: tokenValue,
    };
  } catch (error) {
    logger.debug(
      {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      },
      "validateExternalIdpToken: unexpected error",
    );
    return null;
  }
}

// =============================================================================
// Internal helpers for external IdP validation
// =============================================================================

type OidcConfigForJwks = {
  clientId?: string;
  jwksEndpoint?: string;
};

/**
 * Simple identity provider lookup by ID (no org check).
 * Uses direct DB query since the IdentityProviderModel is enterprise-only (.ee.ts).
 * The schema file (identity-provider.ts) is NOT .ee, so this is safe to use.
 */
async function findIdentityProviderById(id: string) {
  const [provider] = await db
    .select({
      id: dbSchema.identityProvidersTable.id,
      providerId: dbSchema.identityProvidersTable.providerId,
      issuer: dbSchema.identityProvidersTable.issuer,
      oidcConfig: dbSchema.identityProvidersTable.oidcConfig,
    })
    .from(dbSchema.identityProvidersTable)
    .where(eq(dbSchema.identityProvidersTable.id, id));

  return provider ?? null;
}

function parseJsonField<T>(value: unknown): T | null {
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

/**
 * Cache for OIDC discovery results (issuer → jwks_uri).
 * Bounded to MAX_OIDC_DISCOVERY_CACHE_SIZE entries with LRU-style eviction
 * (oldest entry removed when full). In practice this cache is very small —
 * entries correspond to configured identity providers, not user-controlled input.
 */
const MAX_OIDC_DISCOVERY_CACHE_SIZE = 100;
const oidcDiscoveryCache = new Map<string, string>();
const oidcDiscoveryInflight = new Map<string, Promise<string | null>>();

/**
 * Discover the JWKS URL from an OIDC issuer's well-known configuration.
 * Results are cached in memory. Concurrent requests for the same issuer
 * are deduplicated to avoid redundant network calls.
 */
async function discoverJwksUrl(issuerUrl: string): Promise<string | null> {
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

async function fetchOidcJwksUrl(issuerUrl: string): Promise<string | null> {
  try {
    // Normalize issuer URL (remove trailing slash for consistent well-known URL construction)
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

    const metadata = (await response.json()) as { jwks_uri?: string };
    const jwksUri = metadata.jwks_uri;
    if (!jwksUri || typeof jwksUri !== "string") {
      logger.warn({ issuerUrl }, "OIDC discovery: no jwks_uri in metadata");
      return null;
    }

    // Evict oldest entry if cache is full
    if (oidcDiscoveryCache.size >= MAX_OIDC_DISCOVERY_CACHE_SIZE) {
      const oldestKey = oidcDiscoveryCache.keys().next().value;
      if (oldestKey) oidcDiscoveryCache.delete(oldestKey);
    }
    oidcDiscoveryCache.set(issuerUrl, jwksUri);
    return jwksUri;
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
