import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  hasArchestraTokenPrefix,
  isAgentTool,
  MCP_APPS_SERVER_EXTENSION_CAPABILITIES,
  MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
  OAUTH_TOKEN_ID_PREFIX,
  parseFullToolName,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@shared";
import type { FastifyRequest } from "fastify";
import {
  archestraMcpBranding,
  executeArchestraTool,
  filterToolNamesByPermission,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import { userHasPermission } from "@/auth/utils";
import { LRUCacheManager } from "@/cache-manager";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import logger from "@/logging";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  AgentModel,
  AgentTeamModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  McpToolCallModel,
  MemberModel,
  OAuthAccessTokenModel,
  TeamTokenModel,
  ToolModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import { findAgentAccessContextById } from "@/models/agent-access-context";
import { metrics } from "@/observability";
import {
  ATTR_MCP_IS_ERROR_RESULT,
  startActiveMcpSpan,
} from "@/observability/tracing";
import { MCP_RESOURCE_REFERENCE_PREFIX } from "@/services/identity-providers/enterprise-managed/authorization";
import {
  discoverOidcJwksUrl,
  findExternalIdentityProviderById,
} from "@/services/identity-providers/oidc";
import { jwksValidator } from "@/services/jwks-validator";
import type {
  AgentAccessContext,
  AgentType,
  CommonToolCall,
  SelectTeamToken,
  SelectUserToken,
  ToolExposureMode,
} from "@/types";
import type { McpServerCapabilitiesWithExtensions } from "@/types/mcp-capabilities";
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

export type AgentInfo = {
  name: string;
  id: string;
  agentType?: AgentType;
  labels?: Array<{ key: string; value: string }>;
  passthroughHeaders?: string[] | null;
};

type TokenHashes = {
  cacheKey: string;
  oauthTokenHash: string;
  rawTokenHash: string;
};

type ResolvedArchestraToken =
  | {
      type: "team";
      token: SelectTeamToken;
    }
  | {
      type: "user";
      token: SelectUserToken;
    };

const TOKEN_AUTH_CACHE_TTL_MS = 30_000;
const TOKEN_AUTH_CACHE_NULL_TTL_MS = 5_000;
const TOKEN_AUTH_CACHE_MAX_ENTRIES = 1_000;
const tokenAuthCache = new LRUCacheManager<TokenAuthResult | null>({
  maxSize: TOKEN_AUTH_CACHE_MAX_ENTRIES,
  defaultTtl: TOKEN_AUTH_CACHE_TTL_MS,
});
const rawArchestraTokenCache =
  new LRUCacheManager<ResolvedArchestraToken | null>({
    maxSize: TOKEN_AUTH_CACHE_MAX_ENTRIES,
    defaultTtl: TOKEN_AUTH_CACHE_TTL_MS,
  });

/**
 * Creates an MCP server for the given agent.
 */
export async function createAgentServer(
  agentId: string,
  tokenAuth?: TokenAuthContext,
): Promise<{ server: McpServer; agent: AgentInfo }> {
  const extensionCapabilities = {
    ...MCP_APPS_SERVER_EXTENSION_CAPABILITIES,
    ...MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
  } as const;

  const mcpServer = new McpServer(
    {
      name: `archestra-agent-${agentId}`,
      version: config.api.version,
    },
    {
      capabilities: {
        resources: {
          subscribe: true,
          listChanged: true,
        },
        extensions: extensionCapabilities,
        prompts: {},
        tools: { listChanged: false },
      } as McpServerCapabilitiesWithExtensions,
    },
  );
  const { server } = mcpServer;

  const agent = await AgentModel.findById(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

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

    const implicitMetaTools =
      agent.toolExposureMode === "search_and_run_only"
        ? getImplicitArchestraMetaTools()
        : [];
    const candidateTools = dedupeToolsByName(
      [...mcpTools, ...implicitMetaTools].map(toMcpListTool),
    );

    // Filter Archestra tools based on user RBAC permissions
    const permittedNames = await filterToolNamesByPermission(
      candidateTools.map((t) => t.name),
      tokenAuth?.userId,
      tokenAuth?.organizationId,
    );
    const permittedTools = filterExposedTools({
      toolExposureMode: agent.toolExposureMode ?? "full",
      tools: candidateTools.filter((t) => permittedNames.has(t.name)),
    });

    // Dynamically enrich the knowledge sources tool description with
    // the agent's actual knowledge base names and connector types
    const kbToolDescription = await buildKnowledgeSourcesDescription(agentId);

    const toolsList = permittedTools.map(
      ({ name, description, parameters, meta }) => ({
        name,
        title: archestraToolTitles.get(name) || name,
        description:
          name ===
            archestraMcpBranding.getToolName(
              TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
            ) && kbToolDescription
            ? kbToolDescription
            : description,
        inputSchema: parameters,
        annotations: meta?.annotations || {},
        _meta: meta?._meta || {},
      }),
    );

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
        "Saved tools/list request",
      );
    } catch (dbError) {
      logger.warn({ err: dbError }, "Failed to persist tools/list request:");
    }

    return { tools: toolsList };
  });

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async ({ params: { uri } }) => {
      try {
        logger.info(
          { agentId, uri },
          "MCP gateway read resource request received",
        );
        const result = await mcpClient.readResource(uri, agentId, tokenAuth);
        logger.info(
          { agentId, uri, resultType: typeof result },
          "Resource read successful",
        );
        return result;
      } catch (error) {
        logger.error(
          {
            agentId,
            uri,
            error: error instanceof Error ? error.message : "Unknown error",
            stack: error instanceof Error ? error.stack : undefined,
          },
          "Resource read failed",
        );
        throw {
          code: -32603,
          message: "Resource read failed",
          data: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // SEP-1865: resources/list, resources/templates/list, prompts/list
  // Proxy to all upstream MCP servers connected to this agent and aggregate results.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return mcpClient.listResources(agentId);
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return mcpClient.listResourceTemplates(agentId);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return mcpClient.listPrompts(agentId);
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }) => {
      const startTime = Date.now();
      const mcpServerName = parseFullToolName(name).serverName ?? "unknown";

      // Resolve user identity for OTEL span attributes
      let mcpUser: {
        id: string;
        email?: string;
        name?: string;
      } | null = null;
      if (tokenAuth?.userId) {
        const userDetails = await UserModel.getById(tokenAuth.userId);
        if (userDetails) {
          mcpUser = {
            id: userDetails.id,
            email: userDetails.email,
            name: userDetails.name,
          };
        }
      }

      try {
        // Check if this is an Archestra tool or agent delegation tool
        const isArchestraTool = archestraMcpBranding.isToolName(name);
        const isAgentDelegationTool = isAgentTool(name);

        if (isArchestraTool || isAgentDelegationTool) {
          logger.info(
            {
              agentId,
              toolName: name,
              toolType: isAgentDelegationTool
                ? "agent-delegation"
                : "archestra",
            },
            isAgentDelegationTool
              ? "Agent delegation tool call received"
              : "Archestra MCP tool call received",
          );

          // Handle Archestra and agent delegation tools directly
          const response = await startActiveMcpSpan({
            toolName: name,
            mcpServerName,
            agent,
            agentType: agent.agentType,
            toolCallId: `archestra-${Date.now()}`,
            toolArgs: args,
            user: mcpUser,
            callback: async (span) => {
              const result = await executeArchestraTool(name, args, {
                agent: { id: agent.id, name: agent.name },
                agentId: agent.id,
                userId: tokenAuth?.userId,
                organizationId: tokenAuth?.organizationId,
                tokenAuth,
              });
              span.setAttribute(
                ATTR_MCP_IS_ERROR_RESULT,
                result.isError ?? false,
              );
              return result;
            },
          });

          const durationSeconds = (Date.now() - startTime) / 1000;
          metrics.mcp.reportMcpToolCall({
            agentId: agent.id,
            agentName: agent.name,
            agentType: agent.agentType ?? null,
            mcpServerName,
            toolName: name,
            durationSeconds,
            isError: false,
            agentLabels: agent.labels,
            requestSizeBytes: args ? JSON.stringify(args).length : undefined,
            responseSizeBytes: response.content
              ? JSON.stringify(response.content).length
              : undefined,
          });

          logger.info(
            {
              agentId,
              toolName: name,
            },
            isAgentDelegationTool
              ? "Agent delegation tool call completed"
              : "Archestra MCP tool call completed",
          );

          // Persist archestra/agent delegation tool call to database
          try {
            await McpToolCallModel.create({
              agentId,
              mcpServerName: archestraMcpBranding.serverName,
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
          agentType: agent.agentType,
          toolCallId,
          toolArgs: args,
          user: mcpUser,
          callback: async (span) => {
            const r = await mcpClient.executeToolCall(
              toolCall,
              agentId,
              tokenAuth,
            );
            span.setAttribute(ATTR_MCP_IS_ERROR_RESULT, r.isError ?? false);
            return r;
          },
        });

        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.mcp.reportMcpToolCall({
          agentId: agent.id,
          agentName: agent.name,
          agentType: agent.agentType ?? null,
          mcpServerName,
          toolName: name,
          durationSeconds,
          isError: result.isError ?? false,
          agentLabels: agent.labels,
          requestSizeBytes: args ? JSON.stringify(args).length : undefined,
          responseSizeBytes: result.content
            ? JSON.stringify(result.content).length
            : undefined,
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
          _meta: result._meta,
          structuredContent: result.structuredContent,
        };
      } catch (error) {
        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.mcp.reportMcpToolCall({
          agentId: agent.id,
          agentName: agent.name,
          agentType: agent.agentType ?? null,
          mcpServerName,
          toolName: name,
          durationSeconds,
          isError: true,
          agentLabels: agent.labels,
          requestSizeBytes: args ? JSON.stringify(args).length : undefined,
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
  return { server: mcpServer, agent };
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
 * Extract profile ID from URL path and token from Authorization header.
 * URL format: /v1/mcp/:profileId (accepts both UUID and slug)
 */
export async function extractProfileIdAndTokenFromRequest(
  request: FastifyRequest,
): Promise<{ profileId: string; token: string } | null> {
  const token = extractBearerToken(request);
  if (!token) {
    return null;
  }

  // Extract profile ID or slug from URL path (last segment)
  const idOrSlug = request.url.split("/").at(-1)?.split("?")[0];
  if (!idOrSlug) {
    return null;
  }

  const profileId = await AgentModel.resolveIdFromIdOrSlug(idOrSlug);
  return profileId ? { profileId, token } : null;
}

/**
 * Extract headers from an incoming request that match the gateway's passthrough allowlist.
 * Returns a map of header name → value, or undefined if none matched.
 */
export function extractPassthroughHeaders(
  allowlist: string[] | null | undefined,
  requestHeaders: Record<string, string | string[] | undefined>,
): Record<string, string> | undefined {
  if (!allowlist || allowlist.length === 0) {
    return undefined;
  }
  const extracted: Record<string, string> = {};
  for (const headerName of allowlist) {
    const value = requestHeaders[headerName.toLowerCase()];
    if (typeof value === "string") {
      extracted[headerName] = value;
    } else if (Array.isArray(value)) {
      extracted[headerName] = value.join(", ");
    }
  }
  return Object.keys(extracted).length > 0 ? extracted : undefined;
}

/**
 * Validate a platform-managed token for a specific profile
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
  agentAccessContext?: AgentAccessContext | null,
): Promise<TokenAuthResult | null> {
  // Validate the token itself
  const token = await TeamTokenModel.validateToken(tokenValue);
  if (!token) {
    return null;
  }

  return validateResolvedTeamToken({
    profileId,
    token,
    agentAccessContext,
  });
}

async function validateResolvedTeamToken(params: {
  profileId: string;
  token: SelectTeamToken;
  agentAccessContext?: AgentAccessContext | null;
}): Promise<TokenAuthResult | null> {
  const { profileId, token, agentAccessContext } = params;

  // Check if profile is accessible via this token
  if (!token.isOrganizationToken) {
    // Team token: profile must be assigned to this team, or be teamless (org-wide)
    const hasAccess = await AgentTeamModel.teamHasAgentAccess(
      profileId,
      token.teamId,
      agentAccessContext,
    );
    if (!hasAccess) {
      logger.warn(
        { profileId, tokenTeamId: token.teamId },
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
 *    - User has mcpGateway:admin permission (can access all gateways), OR
 *    - User is a member of at least one team that the profile is assigned to
 */
export async function validateUserToken(
  profileId: string,
  tokenValue: string,
  agentAccessContext?: AgentAccessContext | null,
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

  return validateResolvedUserToken({
    profileId,
    token,
    agentAccessContext,
  });
}

async function validateResolvedUserToken(params: {
  profileId: string;
  token: SelectUserToken;
  agentAccessContext?: AgentAccessContext | null;
}): Promise<TokenAuthResult | null> {
  const { profileId, token, agentAccessContext } = params;

  // Check if user has MCP gateway admin permission (can access all gateways)
  const isGatewayAdmin = await userHasPermission(
    token.userId,
    token.organizationId,
    "mcpGateway",
    "admin",
  );

  if (isGatewayAdmin) {
    return {
      tokenId: token.id,
      teamId: null, // User tokens aren't scoped to a single team
      isOrganizationToken: false,
      organizationId: token.organizationId,
      isUserToken: true,
      userId: token.userId,
    };
  }

  // Non-admin: user can access profile if it's teamless (org-wide) or shares a team
  if (
    !(await AgentTeamModel.userHasAgentAccess(
      token.userId,
      profileId,
      false,
      agentAccessContext,
    ))
  ) {
    logger.warn(
      { profileId, userId: token.userId },
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
export async function validateOAuthToken(params: {
  profileId: string;
  tokenValue: string;
}): Promise<TokenAuthResult | null>;
export async function validateOAuthToken(
  profileId: string,
  tokenValue: string,
): Promise<TokenAuthResult | null>;
export async function validateOAuthToken(
  profileIdOrParams:
    | string
    | {
        profileId: string;
        tokenValue: string;
      },
  tokenValueArg?: string,
): Promise<TokenAuthResult | null> {
  const profileId =
    typeof profileIdOrParams === "string"
      ? profileIdOrParams
      : profileIdOrParams.profileId;
  const tokenValue =
    typeof profileIdOrParams === "string"
      ? tokenValueArg
      : profileIdOrParams.tokenValue;

  if (!tokenValue) {
    return null;
  }

  const oauthTokenHash = buildOAuthTokenHash(tokenValue);
  return validateOAuthTokenByHash({ profileId, oauthTokenHash });
}

async function validateOAuthTokenByHash(params: {
  profileId: string;
  oauthTokenHash: string;
  agentAccessContext?: AgentAccessContext | null;
}): Promise<TokenAuthResult | null> {
  try {
    const agent =
      params.agentAccessContext ??
      (await findAgentAccessContextById(params.profileId));
    if (!agent) {
      return null;
    }

    // Look up the hashed token via the model
    const accessToken = await OAuthAccessTokenModel.getByTokenHash(
      params.oauthTokenHash,
    );

    if (!accessToken) {
      return null;
    }

    // Check if associated refresh token has been revoked
    if (accessToken.refreshTokenRevoked) {
      logger.debug(
        { profileId: params.profileId },
        "validateOAuthToken: associated refresh token is revoked",
      );
      return null;
    }

    // Check token expiry
    if (accessToken.expiresAt < new Date()) {
      logger.debug(
        { profileId: params.profileId },
        "validateOAuthToken: token expired",
      );
      return null;
    }

    if (
      accessToken.referenceId?.startsWith(MCP_RESOURCE_REFERENCE_PREFIX) &&
      accessToken.referenceId !==
        `${MCP_RESOURCE_REFERENCE_PREFIX}${params.profileId}`
    ) {
      logger.warn(
        {
          profileId: params.profileId,
          tokenReferenceId: accessToken.referenceId,
        },
        "validateOAuthToken: token is bound to a different MCP resource",
      );
      return null;
    }

    const userId = accessToken.userId;
    if (!userId) {
      return null;
    }
    const organizationId = agent.organizationId;

    // Check if user has MCP gateway admin permission (can access all gateways)
    const isGatewayAdmin = await userHasPermission(
      userId,
      organizationId,
      "mcpGateway",
      "admin",
    );

    if (isGatewayAdmin) {
      return {
        tokenId: `${OAUTH_TOKEN_ID_PREFIX}${accessToken.id}`,
        teamId: null,
        isOrganizationToken: false,
        organizationId,
        isUserToken: true,
        userId,
      };
    }

    // Non-admin: user can access profile if it's teamless (org-wide) or shares a team
    if (
      !(await AgentTeamModel.userHasAgentAccess(
        userId,
        params.profileId,
        false,
        agent,
      ))
    ) {
      logger.warn(
        { profileId: params.profileId, userId },
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
        profileId: params.profileId,
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
  const tokenHashes = buildTokenHashes(profileId, tokenValue);
  const cachedResult = getCachedTokenAuthResult(tokenHashes.cacheKey);
  if (cachedResult !== undefined) {
    return cachedResult;
  }

  let agentAccessContextPromise: Promise<AgentAccessContext | null> | undefined;
  const getAgentAccessContext =
    async (): Promise<AgentAccessContext | null> => {
      if (!agentAccessContextPromise) {
        agentAccessContextPromise = findAgentAccessContextById(profileId);
      }
      return agentAccessContextPromise;
    };

  // Try external IdP JWKS validation first (if profile has an IdP configured)
  if (!hasArchestraTokenPrefix(tokenValue)) {
    const externalIdpResult = await validateExternalIdpToken(
      profileId,
      tokenValue,
    );
    if (externalIdpResult) {
      cacheTokenAuthResult(tokenHashes.cacheKey, externalIdpResult);
      return externalIdpResult;
    }
  }

  if (hasArchestraTokenPrefix(tokenValue)) {
    const resolvedToken = await resolveArchestraToken(
      tokenValue,
      tokenHashes.rawTokenHash,
    );
    if (resolvedToken?.type === "team") {
      const teamTokenResult = await validateResolvedTeamToken({
        profileId,
        token: resolvedToken.token,
        agentAccessContext: resolvedToken.token.isOrganizationToken
          ? null
          : await getAgentAccessContext(),
      });
      if (teamTokenResult) {
        cacheTokenAuthResult(tokenHashes.cacheKey, teamTokenResult);
        return teamTokenResult;
      }
    }

    if (resolvedToken?.type === "user") {
      const userTokenResult = await validateResolvedUserToken({
        profileId,
        token: resolvedToken.token,
        agentAccessContext: await getAgentAccessContext(),
      });
      if (userTokenResult) {
        cacheTokenAuthResult(tokenHashes.cacheKey, userTokenResult);
        return userTokenResult;
      }
    }

    logger.warn(
      { profileId, tokenPrefix: tokenValue.substring(0, 14) },
      "validateMCPGatewayToken: token validation failed - not found in any token table or access denied",
    );
    cacheTokenAuthResult(tokenHashes.cacheKey, null);
    return null;
  }

  // Try OAuth token validation (for MCP clients like Open WebUI)
  const oauthResult = await validateOAuthTokenByHash({
    profileId,
    oauthTokenHash: tokenHashes.oauthTokenHash,
    agentAccessContext: await getAgentAccessContext(),
  });
  if (oauthResult) {
    // This cache is intentionally short-lived and process-local. Revocations
    // may take up to TOKEN_AUTH_CACHE_TTL_MS to fully age out across requests.
    cacheTokenAuthResult(tokenHashes.cacheKey, oauthResult);
    return oauthResult;
  }

  logger.warn(
    { profileId, tokenPrefix: tokenValue.substring(0, 14) },
    "validateMCPGatewayToken: token validation failed - not found in any token table or access denied",
  );
  cacheTokenAuthResult(tokenHashes.cacheKey, null);
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
  permissionResource: "mcpGateway" | "llmProxy" = "mcpGateway",
): Promise<TokenAuthResult | null> {
  try {
    // Look up the agent to check if it has an identity provider configured
    const agent = await AgentModel.findById(profileId);
    if (!agent?.identityProviderId) {
      return null;
    }

    // Look up the identity provider to get OIDC config
    const idpProvider = await findExternalIdentityProviderById(
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

    const oidcConfig = idpProvider.oidcConfig;
    if (!oidcConfig) {
      return null;
    }

    if (!oidcConfig.clientId) {
      logger.warn(
        { profileId, identityProviderId: agent.identityProviderId },
        "validateExternalIdpToken: identity provider OIDC clientId is required for audience validation",
      );
      return null;
    }

    // Use the JWKS endpoint from OIDC config if available (avoids OIDC discovery
    // round-trip, and works when the issuer URL isn't reachable from the backend
    // e.g. in CI where the issuer is a NodePort URL but the backend runs in a pod).
    // Fall back to OIDC discovery from the issuer URL.
    const jwksUrl =
      oidcConfig.jwksEndpoint ??
      (await discoverOidcJwksUrl(idpProvider.issuer));
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
      audience: oidcConfig.clientId,
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

    // Check if user has admin permission for the target resource (MCP Gateway or LLM Proxy)
    const isAdmin = await userHasPermission(
      user.id,
      agent.organizationId,
      permissionResource,
      "admin",
    );

    if (isAdmin) {
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

    // Non-admin: user can access profile if it's teamless (org-wide) or shares a team
    if (!(await AgentTeamModel.userHasAgentAccess(user.id, profileId, false))) {
      logger.warn(
        { profileId, userId: user.id },
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

/**
 * TTL cache for buildKnowledgeSourcesDescription to avoid repeated DB queries
 * on every tools/list request. Invalidated after 30 seconds.
 */
const kbDescriptionCache = new Map<
  string,
  { description: string | null; expiresAt: number }
>();
const KB_DESCRIPTION_CACHE_TTL_MS = 30_000;

function getCachedTokenAuthResult(
  cacheKey: string,
): TokenAuthResult | null | undefined {
  return tokenAuthCache.get(cacheKey);
}

function getCachedRawArchestraToken(
  rawTokenHash: string,
): ResolvedArchestraToken | null | undefined {
  return rawArchestraTokenCache.get(rawTokenHash);
}

function cacheTokenAuthResult(
  cacheKey: string,
  result: TokenAuthResult | null,
): void {
  tokenAuthCache.set(
    cacheKey,
    result,
    result ? TOKEN_AUTH_CACHE_TTL_MS : TOKEN_AUTH_CACHE_NULL_TTL_MS,
  );
}

function cacheRawArchestraToken(
  rawTokenHash: string,
  result: ResolvedArchestraToken | null,
): void {
  rawArchestraTokenCache.set(
    rawTokenHash,
    result,
    result ? TOKEN_AUTH_CACHE_TTL_MS : TOKEN_AUTH_CACHE_NULL_TTL_MS,
  );
}

function buildTokenHashes(profileId: string, tokenValue: string): TokenHashes {
  const digest = createHash("sha256").update(tokenValue).digest();
  return {
    cacheKey: `${profileId}:${digest.toString("hex")}`,
    oauthTokenHash: digest.toString("base64url"),
    rawTokenHash: digest.toString("hex"),
  };
}

function buildOAuthTokenHash(tokenValue: string): string {
  return createHash("sha256").update(tokenValue).digest("base64url");
}

async function resolveArchestraToken(
  tokenValue: string,
  rawTokenHash: string,
): Promise<ResolvedArchestraToken | null> {
  const cached = getCachedRawArchestraToken(rawTokenHash);
  if (cached !== undefined) {
    return cached;
  }

  const teamToken = await TeamTokenModel.validateToken(tokenValue);
  if (teamToken) {
    const result: ResolvedArchestraToken = {
      type: "team",
      token: teamToken,
    };
    cacheRawArchestraToken(rawTokenHash, result);
    return result;
  }

  const userToken = await UserTokenModel.validateToken(tokenValue);
  if (userToken) {
    const result: ResolvedArchestraToken = {
      type: "user",
      token: userToken,
    };
    cacheRawArchestraToken(rawTokenHash, result);
    return result;
  }

  cacheRawArchestraToken(rawTokenHash, null);
  return null;
}

/**
 * Build a dynamic description for the query_knowledge_sources tool that includes
 * the agent's actual knowledge base names and connector sources.
 * Results are cached per agentId with a 30s TTL.
 */
export async function buildKnowledgeSourcesDescription(
  agentId: string,
): Promise<string | null> {
  const cached = kbDescriptionCache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.description;
  }

  const [kbAssignments, directConnectorIds] = await Promise.all([
    AgentKnowledgeBaseModel.findByAgent(agentId),
    AgentConnectorAssignmentModel.getConnectorIds(agentId),
  ]);

  if (kbAssignments.length === 0 && directConnectorIds.length === 0) {
    kbDescriptionCache.set(agentId, {
      description: null,
      expiresAt: Date.now() + KB_DESCRIPTION_CACHE_TTL_MS,
    });
    return null;
  }

  const kbIds = kbAssignments.map((a) => a.knowledgeBaseId);

  const [knowledgeBases, kbConnectors, directConnectors] = await Promise.all([
    kbIds.length > 0 ? KnowledgeBaseModel.findByIds(kbIds) : [],
    kbIds.length > 0
      ? KnowledgeBaseConnectorModel.findByKnowledgeBaseIds(kbIds)
      : [],
    KnowledgeBaseConnectorModel.findByIds(directConnectorIds),
  ]);

  const kbNames = knowledgeBases.map((kb) => kb.name);
  const allConnectors = [...kbConnectors, ...directConnectors];
  const connectorTypes = [
    ...new Set(allConnectors.map((c) => c.connectorType)),
  ];

  let description =
    "Query the organization's knowledge sources to retrieve relevant information. " +
    "Use this tool when the user asks a question you cannot answer from your training data alone, " +
    "or when they explicitly ask you to search internal documents and data sources. " +
    "Pass the user's original query as-is — do not rephrase, summarize, or expand it. " +
    "The system performs its own query optimization internally.";

  if (kbNames.length > 0) {
    const kbList = kbNames.join(", ");
    description +=
      kbList.length > 500
        ? ` Available knowledge bases: ${kbList.slice(0, 500)}...`
        : ` Available knowledge bases: ${kbList}.`;
  }
  if (connectorTypes.length > 0) {
    description += ` Connected sources: ${connectorTypes.join(", ")}.`;
  }

  description +=
    " Pass the user's original query verbatim — the system handles query optimization internally.";

  kbDescriptionCache.set(agentId, {
    description,
    expiresAt: Date.now() + KB_DESCRIPTION_CACHE_TTL_MS,
  });

  return description;
}

function filterExposedTools(params: {
  toolExposureMode: ToolExposureMode;
  tools: McpListTool[];
}) {
  const { toolExposureMode, tools } = params;
  return tools.filter((tool) => {
    const isMetaTool = isArchestraMetaTool(tool.name);
    return toolExposureMode === "search_and_run_only"
      ? isMetaTool
      : !isMetaTool;
  });
}

type McpListTool = {
  name: string;
  description: string | null;
  parameters: unknown;
  meta?: {
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
};

function toMcpListTool(tool: {
  name: string;
  description?: string | null;
  parameters?: unknown;
  meta?: {
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  } | null;
}): McpListTool {
  return {
    name: tool.name,
    description: tool.description ?? null,
    parameters: tool.parameters ?? {},
    meta: tool.meta ?? undefined,
  };
}

function getImplicitArchestraMetaTools() {
  return getArchestraMcpTools().filter((tool) =>
    isArchestraMetaTool(tool.name),
  );
}

function dedupeToolsByName<T extends { name: string }>(tools: T[]) {
  const deduped = new Map<string, T>();
  for (const tool of tools) {
    deduped.set(tool.name, tool);
  }
  return Array.from(deduped.values());
}

function isArchestraMetaTool(toolName: string) {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  return (
    shortName === TOOL_SEARCH_TOOLS_SHORT_NAME ||
    shortName === TOOL_RUN_TOOL_SHORT_NAME
  );
}
