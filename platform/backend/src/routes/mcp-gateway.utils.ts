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
} from "@shared";
import type { FastifyRequest } from "fastify";
import {
  executeArchestraTool,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import { userHasPermission } from "@/auth/utils";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
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
  UserTokenModel,
} from "@/models";
import {
  type CommonToolCall,
  type MCPGatewayAuthMethod,
  UuidIdSchema,
} from "@/types";
import { estimateToolResultContentLength } from "@/utils/tool-result-preview";

/**
 * Derive a human-readable auth method string from token auth context
 */
export function deriveAuthMethod(
  tokenAuth: TokenAuthResult | TokenAuthContext | undefined,
): MCPGatewayAuthMethod | undefined {
  if (!tokenAuth) return undefined;
  if (tokenAuth.tokenId.startsWith(OAUTH_TOKEN_ID_PREFIX)) return "oauth";
  if (tokenAuth.isUserToken) return "user_token";
  if (tokenAuth.isOrganizationToken) return "org_token";
  return "team_token";
}

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
}

/**
 * Create a fresh MCP server for a request
 * In stateless mode, we need to create new server instances per request
 */
export async function createAgentServer(
  agentId: string,
  logger: { info: (obj: unknown, msg: string) => void },
  cachedAgent?: { name: string; id: string },
  tokenAuth?: TokenAuthContext,
): Promise<{ server: Server; agent: { name: string; id: string } }> {
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

  // Use cached agent data if available, otherwise fetch it
  let agent = cachedAgent;
  if (!agent) {
    const fetchedAgent = await AgentModel.findById(agentId);
    if (!fetchedAgent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    agent = fetchedAgent;
  }

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
      logger.info({ err: dbError }, "Failed to persist tools/list request:");
    }

    return { tools: toolsList };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }) => {
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
          const response = await executeArchestraTool(name, args, {
            agent: { id: agent.id, name: agent.name },
            agentId: agent.id,
            organizationId: tokenAuth?.organizationId,
            tokenAuth,
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

        // Execute the tool call via McpClient (pass tokenAuth for dynamic credential resolution)
        const result = await mcpClient.executeToolCall(
          toolCall,
          agentId,
          tokenAuth,
        );

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
  logger: { info: (obj: unknown, msg: string) => void },
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
 * Validate any archestra_ prefixed token for a specific profile
 * Tries team/org tokens first, then user tokens, then OAuth JWT tokens
 * Returns token auth info if valid, null otherwise
 */
export async function validateMCPGatewayToken(
  profileId: string,
  tokenValue: string,
): Promise<TokenAuthResult | null> {
  // First try team/org token validation
  const teamTokenResult = await validateTeamToken(profileId, tokenValue);
  if (teamTokenResult) {
    return teamTokenResult;
  }

  // Then try user token validation
  const userTokenResult = await validateUserToken(profileId, tokenValue);
  if (userTokenResult) {
    return userTokenResult;
  }

  // Try OAuth JWT token validation (for MCP clients like Open WebUI)
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
