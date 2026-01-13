import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import type { FastifyRequest } from "fastify";
import {
  executeArchestraTool,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import { userHasPermission } from "@/auth/utils";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  isArchestraPrefixedToken,
  McpToolCallModel,
  TeamModel,
  TeamTokenModel,
  ToolModel,
  UserTokenModel,
} from "@/models";
import { type CommonToolCall, UuidIdSchema } from "@/types";
import { estimateToolResultContentLength } from "@/utils/tool-result-preview";

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
 * Session management types
 */
export interface SessionData {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastAccess: number;
  agentId: string;
  agent?: {
    id: string;
    name: string;
  }; // Cache agent data
  // Token auth info (only present for archestra_ token auth)
  tokenAuth?: {
    tokenId: string;
    teamId: string | null;
    isOrganizationToken: boolean;
  };
}

/**
 * Active sessions with last access time for cleanup
 * Sessions must persist across requests within the same session
 */
export const activeSessions = new Map<string, SessionData>();

/**
 * Session timeout (30 minutes)
 */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Clean up expired sessions periodically
 */
export function cleanupExpiredSessions(): void {
  const now = Date.now();
  const expiredSessionIds: string[] = [];

  for (const [sessionId, sessionData] of activeSessions.entries()) {
    if (now - sessionData.lastAccess > SESSION_TIMEOUT_MS) {
      expiredSessionIds.push(sessionId);
    }
  }

  for (const sessionId of expiredSessionIds) {
    logger.info({ sessionId }, "Cleaning up expired session");
    activeSessions.delete(sessionId);
  }
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
        // Check if this is an Archestra tool
        const archestraToolPrefix = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`;
        if (name.startsWith(archestraToolPrefix)) {
          logger.info(
            {
              agentId,
              toolName: name,
            },
            "Archestra MCP tool call received",
          );

          // Handle Archestra tools directly
          const archestraResponse = await executeArchestraTool(name, args, {
            profile: { id: agent.id, name: agent.name },
          });

          logger.info(
            {
              agentId,
              toolName: name,
            },
            "Archestra MCP tool call completed",
          );

          return archestraResponse;
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
 * Create a fresh transport for a request
 * We use session-based mode as required by the SDK for JSON responses
 */
export function createTransport(
  agentId: string,
  clientSessionId: string | undefined,
  logger: { info: (obj: unknown, msg: string) => void },
): StreamableHTTPServerTransport {
  logger.info({ agentId, clientSessionId }, "Creating new transport instance");

  // Create transport with session management
  // If client provides a session ID, we'll use it; otherwise generate one
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      const sessionId =
        clientSessionId || `session-${Date.now()}-${randomUUID()}`;
      logger.info(
        { agentId, sessionId, wasClientProvided: !!clientSessionId },
        "Using session ID",
      );
      return sessionId;
    },
    enableJsonResponse: true, // Use JSON responses instead of SSE
  });

  logger.info({ agentId }, "Transport instance created");
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

export function extractProfileIdAndTokenFromRequest(
  request: FastifyRequest,
): { profileId: string; token: string } | null {
  const token = extractBearerToken(request);
  if (!token) {
    return null;
  }

  // Check if it's a new archestra_ prefixed token
  // If it is, we know this is a new format: /mcp/v1/<profile_id>
  if (isArchestraPrefixedToken(token)) {
    const profileId = request.url.split("/").at(-1);
    try {
      const parsedProfileId = UuidIdSchema.parse(profileId);
      return parsedProfileId ? { profileId: parsedProfileId, token } : null;
    } catch {
      return null;
    }
  } else {
    // Legacy UUID token - profileID and token are the same from Authorization header
    try {
      const parsed = UuidIdSchema.parse(token);
      return { profileId: parsed, token };
    } catch {
      return null;
    }
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
    logger.debug(
      { profileId, tokenPrefix: tokenValue.substring(0, 14) },
      "validateTeamToken: token not found in team_token table",
    );
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

  logger.debug(
    { profileId, userId: token.userId, userTeamIds, profileTeamIds, hasAccess },
    "validateUserToken: checking team access",
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
 * Validate any archestra_ prefixed token for a specific profile
 * Tries team/org tokens first, then user tokens
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
    logger.debug(
      { profileId, userId: userTokenResult.userId },
      "validateMCPGatewayToken: validated as user token",
    );
    return userTokenResult;
  }

  logger.warn(
    { profileId, tokenPrefix: tokenValue.substring(0, 14) },
    "validateMCPGatewayToken: token validation failed - not found in any token table or access denied",
  );
  return null;
}

/**
 * Clear all active sessions for a specific agent
 */
export function clearAgentSessions(agentId: string): void {
  const sessionsToClear: string[] = [];

  // Find all sessions for this agent
  for (const [sessionId, sessionData] of activeSessions.entries()) {
    if (sessionData.agentId === agentId) {
      sessionsToClear.push(sessionId);
    }
  }

  // Delete all matching sessions
  for (const sessionId of sessionsToClear) {
    logger.info({ agentId, sessionId }, "Clearing agent session");
    activeSessions.delete(sessionId);
  }

  logger.info(
    { agentId, clearedCount: sessionsToClear.length },
    "All sessions cleared, now clearing cached MCP client",
  );

  // Also clear the cached MCP client so it will reconnect with a new session
  clearChatMcpClient(agentId);

  logger.info(
    { agentId, clearedCount: sessionsToClear.length },
    "✅ Cleared agent sessions and client cache - next request will create fresh session",
  );
}
