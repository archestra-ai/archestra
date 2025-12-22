import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isArchestraMcpServerTool, TimeInMs } from "@shared";
import { jsonSchema, type Tool } from "ai";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { CacheKey, cacheManager } from "@/cache-manager";
import mcpClient from "@/clients/mcp-client";
import logger from "@/logging";
import {
  AgentTeamModel,
  TeamModel,
  TeamTokenModel,
  ToolModel,
  UserTokenModel,
} from "@/models";

/**
 * MCP Gateway base URL (internal)
 * Chat connects to the new MCP Gateway endpoint with profile ID in path
 */
const MCP_GATEWAY_BASE_URL = "http://localhost:9000/v1/mcp";

/**
 * Client cache per agent + user combination
 * Key: `${agentId}:${userId}`, Value: MCP Client
 * Note: This cannot use cacheManager because Client instances need lifecycle
 * management (close() on cleanup) which cacheManager doesn't support.
 */
const clientCache = new Map<string, Client>();

/**
 * Tool cache TTL - 30 seconds to avoid hammering MCP Gateway
 */
const TOOL_CACHE_TTL_MS = 30 * TimeInMs.Second;

/**
 * Generate cache key from agentId and userId
 */
function getCacheKey(agentId: string, userId: string): string {
  return `${agentId}:${userId}`;
}

/**
 * Generate the full cache key for tool cache
 */
function getToolCacheKey(
  agentId: string,
  userId: string,
): `${typeof CacheKey.ChatMcpTools}-${string}` {
  return `${CacheKey.ChatMcpTools}-${getCacheKey(agentId, userId)}`;
}

export const __test = {
  setCachedClient(cacheKey: string, client: Client) {
    clientCache.set(cacheKey, client);
  },
  async clearToolCache(cacheKey?: string) {
    if (cacheKey) {
      await cacheManager.delete(`${CacheKey.ChatMcpTools}-${cacheKey}`);
    }
    // Note: cacheManager doesn't support clearing all keys with a prefix
    // For tests, individual keys should be cleared explicitly
  },
  getCacheKey,
};

/**
 * Select the appropriate token for a user based on team overlap
 * Priority:
 * 1. Personal user token (if user has access to profile via team membership)
 * 2. Organization token (if user is profile admin)
 * 3. Team token where user is a member AND team is assigned to profile
 *
 * @param agentId - The profile (agent) ID
 * @param userId - The user requesting access
 * @param userIsProfileAdmin - Whether the user has profile admin permission
 * @returns Token value and metadata, or null if no token available
 */
async function selectMCPGatewayToken(
  agentId: string,
  userId: string,
  userIsProfileAdmin: boolean,
): Promise<{
  tokenValue: string;
  tokenId: string;
  teamId: string | null;
  isOrganizationToken: boolean;
  isUserToken?: boolean;
} | null> {
  // Get user's team IDs and profile's team IDs (needed for access check)
  const userTeamIds = await TeamModel.getUserTeamIds(userId);
  const profileTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);
  const commonTeamIds = userTeamIds.filter((id) => profileTeamIds.includes(id));

  // 1. Try personal user token first (if user has access via team membership)
  if (commonTeamIds.length > 0) {
    // Get organizationId from one of the common teams
    const team = await TeamModel.findById(commonTeamIds[0]);
    if (team) {
      const userToken = await UserTokenModel.findByUserAndOrg(
        userId,
        team.organizationId,
      );
      if (userToken) {
        const tokenValue = await UserTokenModel.getTokenValue(userToken.id);
        if (tokenValue) {
          logger.info(
            {
              agentId,
              userId,
              tokenId: userToken.id,
            },
            "Using personal user token for chat MCP client",
          );
          return {
            tokenValue,
            tokenId: userToken.id,
            teamId: null,
            isOrganizationToken: false,
            isUserToken: true,
          };
        }
      }
    }
  }

  // Get all team tokens
  const tokens = await TeamTokenModel.findAll();

  // 2. If user is profile admin, use organization token (teamId is null)
  if (userIsProfileAdmin) {
    const orgToken = tokens.find((t) => t.isOrganizationToken);
    if (orgToken) {
      const tokenValue = await TeamTokenModel.getTokenValue(orgToken.id);
      if (tokenValue) {
        logger.info(
          {
            agentId,
            userId,
            tokenId: orgToken.id,
          },
          "Using organization token for chat MCP client",
        );
        return {
          tokenValue,
          tokenId: orgToken.id,
          teamId: null,
          isOrganizationToken: true,
        };
      }
    }
  }

  // 3. Try to find a team token where user is in that team and profile is assigned to it
  if (commonTeamIds.length > 0) {
    for (const token of tokens) {
      if (token.teamId && commonTeamIds.includes(token.teamId)) {
        const tokenValue = await TeamTokenModel.getTokenValue(token.id);
        if (tokenValue) {
          logger.info(
            {
              agentId,
              userId,
              tokenId: token.id,
              teamId: token.teamId,
            },
            "Selected team-scoped token for chat MCP client",
          );
          return {
            tokenValue,
            tokenId: token.id,
            teamId: token.teamId,
            isOrganizationToken: false,
          };
        }
      }
    }
  }

  logger.warn(
    {
      agentId,
      userId,
      userTeamCount: userTeamIds.length,
      profileTeamCount: profileTeamIds.length,
      commonTeamCount: commonTeamIds.length,
      tokenCount: tokens.length,
    },
    "No valid token found for user",
  );

  return null;
}

/**
 * Clear cached client for a specific agent (all users)
 * Should be called when MCP Gateway sessions are cleared
 *
 * Note: Tool cache entries are stored in cacheManager with keys like
 * "chat-mcp-tools-{agentId}:{userId}". Since we don't track all userIds,
 * tool cache entries will expire naturally via TTL (30 seconds).
 *
 * @param agentId - The agent ID whose clients should be cleared
 */
export function clearChatMcpClient(agentId: string): void {
  logger.info(
    { agentId },
    "clearChatMcpClient() called - checking for cached clients",
  );

  let clearedCount = 0;

  // Find and remove all cache entries for this agentId (any user)
  for (const key of clientCache.keys()) {
    if (key.startsWith(`${agentId}:`)) {
      const client = clientCache.get(key);
      if (client) {
        try {
          client.close();
          logger.info(
            { agentId, cacheKey: key },
            "Closed MCP client connection",
          );
        } catch (error) {
          logger.warn(
            { agentId, cacheKey: key, error },
            "Error closing MCP client connection (non-fatal)",
          );
        }
        clientCache.delete(key);
        clearedCount++;
      }
    }
  }

  // Note: Tool cache entries in cacheManager will expire naturally via TTL.
  // cacheManager doesn't support prefix-based deletion, but with a 30s TTL,
  // stale entries will be refreshed quickly.

  logger.info(
    {
      agentId,
      clearedCount,
      remainingCachedClients: clientCache.size,
    },
    "Cleared MCP client cache entries for agent",
  );
}

/**
 * Get or create MCP client for the specified agent and user
 * Connects to internal MCP Gateway with team token authentication
 *
 * @param agentId - The agent (profile) ID
 * @param userId - The user ID for token selection
 * @param userIsProfileAdmin - Whether the user is a profile admin
 * @returns MCP Client connected to the gateway, or null if connection fails
 */
export async function getChatMcpClient(
  agentId: string,
  userId: string,
  userIsProfileAdmin: boolean,
): Promise<Client | null> {
  const cacheKey = getCacheKey(agentId, userId);

  // Check cache first
  const cachedClient = clientCache.get(cacheKey);
  if (cachedClient) {
    logger.info(
      { agentId, userId },
      "✅ Returning cached MCP client for agent/user (existing session will be reused)",
    );
    return cachedClient;
  }

  logger.info(
    {
      agentId,
      userId,
      totalCachedClients: clientCache.size,
    },
    "🔄 No cached client found - creating new MCP client for agent/user via gateway",
  );

  // Select appropriate token for this user
  const tokenResult = await selectMCPGatewayToken(
    agentId,
    userId,
    userIsProfileAdmin,
  );
  if (!tokenResult) {
    logger.error(
      { agentId, userId },
      "No valid team token available for user - cannot connect to MCP Gateway",
    );
    return null;
  }

  const { tokenValue } = tokenResult;

  // Use new URL format with profileId in path
  const mcpGatewayUrl = `${MCP_GATEWAY_BASE_URL}/${agentId}`;

  try {
    // Create StreamableHTTP transport with profile token authentication
    const transport = new StreamableHTTPClientTransport(
      new URL(mcpGatewayUrl),
      {
        requestInit: {
          headers: new Headers({
            Authorization: `Bearer ${tokenValue}`,
            Accept: "application/json, text/event-stream",
          }),
        },
      },
    );

    // Create MCP client
    const client = new Client(
      {
        name: "chat-mcp-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    logger.info(
      { agentId, userId, url: mcpGatewayUrl },
      "Connecting to MCP Gateway...",
    );
    await client.connect(transport);

    logger.info(
      { agentId, userId },
      "Successfully connected to MCP Gateway (new session initialized)",
    );

    // Cache the client
    clientCache.set(cacheKey, client);

    logger.info(
      {
        agentId,
        userId,
        totalCachedClients: clientCache.size,
      },
      "✅ MCP client cached - subsequent requests will reuse this session",
    );

    return client;
  } catch (error) {
    logger.error(
      { error, agentId, userId, url: mcpGatewayUrl },
      "Failed to connect to MCP Gateway for agent/user",
    );
    return null;
  }
}

/**
 * Validate and normalize JSON Schema for OpenAI
 */
// biome-ignore lint/suspicious/noExplicitAny: JSON Schema structure is dynamic and varies by tool
function normalizeJsonSchema(schema: any): any {
  // If schema is missing or invalid, return a minimal valid schema
  if (
    !schema ||
    !schema.type ||
    schema.type === "None" ||
    schema.type === "null"
  ) {
    return {
      type: "object",
      properties: {},
    };
  }

  // Return the schema as-is if it's already valid JSON Schema
  return schema;
}

/**
 * Get all MCP tools for the specified agent and user in AI SDK Tool format
 * Converts MCP JSON Schema to AI SDK Schema using jsonSchema() helper
 *
 * @param agentId - The agent ID to fetch tools for
 * @param userId - The user ID for authentication
 * @param userIsProfileAdmin - Whether the user is a profile admin
 * @param enabledToolIds - Optional array of tool IDs to filter by. Empty array = all tools enabled.
 * @returns Record of tool name to AI SDK Tool object
 */
export async function getChatMcpTools({
  agentName,
  agentId,
  userId,
  userIsProfileAdmin,
  enabledToolIds,
}: {
  agentName: string;
  agentId: string;
  userId: string;
  userIsProfileAdmin: boolean;
  enabledToolIds?: string[];
}): Promise<Record<string, Tool>> {
  const toolCacheKey = getToolCacheKey(agentId, userId);

  // Check cache first using cacheManager
  const cachedTools =
    await cacheManager.get<Record<string, Tool>>(toolCacheKey);
  if (cachedTools) {
    logger.info(
      {
        agentId,
        userId,
        toolCount: Object.keys(cachedTools).length,
      },
      "Returning cached MCP tools for chat",
    );
    // Apply filtering if enabledToolIds provided and non-empty
    return await filterToolsByEnabledIds(cachedTools, enabledToolIds);
  }

  logger.info(
    { agentId, userId },
    "getChatMcpTools() called - fetching client...",
  );

  // Get token for direct tool execution (bypasses HTTP for security)
  const mcpGwToken = await selectMCPGatewayToken(
    agentId,
    userId,
    userIsProfileAdmin,
  );
  if (!mcpGwToken) {
    logger.warn(
      { agentId, userId },
      "No valid team token available for user - cannot execute tools",
    );
    return {};
  }

  // Still use MCP client for listing tools (via MCP Gateway)
  const client = await getChatMcpClient(agentId, userId, userIsProfileAdmin);

  if (!client) {
    logger.warn(
      { agentId, userId },
      "No MCP client available, returning empty tools",
    );
    return {}; // No tools available
  }

  try {
    logger.info({ agentId, userId }, "MCP client available, listing tools...");
    const { tools: mcpTools } = await client.listTools();

    logger.info(
      {
        agentId,
        userId,
        toolCount: mcpTools.length,
        toolNames: mcpTools.map((t) => t.name),
      },
      "Fetched tools from MCP Gateway for agent/user",
    );

    // Convert MCP tools to AI SDK Tool format
    const aiTools: Record<string, Tool> = {};

    for (const mcpTool of mcpTools) {
      try {
        // Normalize the schema and wrap with jsonSchema() helper
        const normalizedSchema = normalizeJsonSchema(mcpTool.inputSchema);

        logger.debug(
          {
            toolName: mcpTool.name,
            schemaType: normalizedSchema.type,
            hasProperties: !!normalizedSchema.properties,
          },
          "Converting MCP tool with JSON Schema",
        );

        // Construct Tool using jsonSchema() to wrap JSON Schema
        aiTools[mcpTool.name] = {
          description: mcpTool.description || `Tool: ${mcpTool.name}`,
          inputSchema: jsonSchema(normalizedSchema),
          // biome-ignore lint/suspicious/noExplicitAny: Tool execute function requires flexible typing for MCP integration
          execute: async (args: any) => {
            logger.info(
              { agentId, userId, toolName: mcpTool.name, arguments: args },
              "Executing MCP tool from chat (direct)",
            );

            try {
              // Check if this is an Archestra tool - handle directly without DB lookup
              if (isArchestraMcpServerTool(mcpTool.name)) {
                logger.info(
                  { agentId, userId, toolName: mcpTool.name },
                  "Executing Archestra tool from chat",
                );

                const archestraResponse = await executeArchestraTool(
                  mcpTool.name,
                  args,
                  { profile: { id: agentId, name: agentName } },
                );

                // Check for errors
                if (archestraResponse.isError) {
                  const errorText = (
                    archestraResponse.content as Array<{
                      type: string;
                      text?: string;
                    }>
                  )
                    .map((item) =>
                      item.type === "text" && item.text
                        ? item.text
                        : JSON.stringify(item),
                    )
                    .join("\n");
                  throw new Error(errorText);
                }

                // Convert MCP content to string for AI SDK
                const content = (
                  archestraResponse.content as Array<{
                    type: string;
                    text?: string;
                  }>
                )
                  .map((item) =>
                    item.type === "text" && item.text
                      ? item.text
                      : JSON.stringify(item),
                  )
                  .join("\n");

                logger.info(
                  { agentId, userId, toolName: mcpTool.name },
                  "Archestra tool execution completed",
                );

                return content;
              }

              // Execute non-Archestra tools via mcpClient
              // This allows passing userId securely without risk of header spoofing
              const toolCall = {
                id: randomUUID(),
                name: mcpTool.name,
                arguments: args || {},
              };

              const result = await mcpClient.executeToolCall(
                toolCall,
                agentId,
                {
                  tokenId: mcpGwToken.tokenId,
                  teamId: mcpGwToken.teamId,
                  isOrganizationToken: mcpGwToken.isOrganizationToken,
                  userId, // Pass userId for user-owned server priority
                },
              );

              // Check if MCP tool returned an error first
              // When isError is true, throw to signal AI SDK that tool execution failed
              // This allows AI SDK to create a tool-error part and continue the conversation
              // Use result.error (not result.content which is null for errors)
              if (result.isError) {
                logger.error(
                  { agentId, userId, toolName: mcpTool.name, result },
                  "MCP tool execution failed",
                );
                throw new Error(result.error || "Tool execution failed");
              }

              logger.info(
                { agentId, userId, toolName: mcpTool.name, result },
                "MCP tool execution completed (direct)",
              );

              // Convert MCP content to string for AI SDK
              const content = (
                result.content as Array<{ type: string; text?: string }>
              )
                .map((item: { type: string; text?: string }) => {
                  if (item.type === "text" && item.text) {
                    return item.text;
                  }
                  return JSON.stringify(item);
                })
                .join("\n");

              return content;
            } catch (error) {
              logger.error(
                {
                  agentId,
                  userId,
                  toolName: mcpTool.name,
                  err: error,
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                },
                "MCP tool execution failed",
              );
              throw error;
            }
          },
        };
      } catch (error) {
        logger.error(
          { agentId, userId, toolName: mcpTool.name, error },
          "Failed to convert MCP tool to AI SDK format, skipping",
        );
        // Skip this tool and continue with others
      }
    }

    logger.info(
      { agentId, userId, convertedToolCount: Object.keys(aiTools).length },
      "Successfully converted MCP tools to AI SDK Tool format",
    );

    // Cache the tools using cacheManager with TTL
    await cacheManager.set(toolCacheKey, aiTools, TOOL_CACHE_TTL_MS);

    // Apply filtering if enabledToolIds provided and non-empty
    return await filterToolsByEnabledIds(aiTools, enabledToolIds);
  } catch (error) {
    logger.error(
      { agentId, userId, error },
      "Failed to fetch tools from MCP Gateway",
    );
    return {};
  }
}

/**
 * Filter tools by enabled tool IDs
 * If enabledToolIds is undefined or empty, returns all tools (default = all enabled)
 * If enabledToolIds has items, fetches tool names by IDs and filters to only include those
 *
 * @param tools - All available tools (keyed by tool name)
 * @param enabledToolIds - Optional array of tool IDs to filter by
 * @returns Filtered tools record
 */
async function filterToolsByEnabledIds(
  tools: Record<string, Tool>,
  enabledToolIds?: string[],
): Promise<Record<string, Tool>> {
  // Empty array or undefined = all tools enabled (default behavior)
  if (!enabledToolIds || enabledToolIds.length === 0) {
    logger.info(
      {
        totalTools: Object.keys(tools).length,
        enabledToolIds: enabledToolIds?.length ?? 0,
        reason: !enabledToolIds ? "undefined" : "empty array",
      },
      "No tool filtering applied - all tools enabled",
    );
    return tools;
  }

  // Fetch tool names for the enabled IDs
  const enabledToolNames = await ToolModel.getNamesByIds(enabledToolIds);

  // Filter tools to only include enabled ones
  const filteredTools: Record<string, Tool> = {};
  const excludedTools: string[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (enabledToolNames.includes(name)) {
      filteredTools[name] = tool;
    } else {
      excludedTools.push(name);
    }
  }

  logger.info(
    {
      totalTools: Object.keys(tools).length,
      enabledToolIds: enabledToolIds.length,
      enabledToolNames: enabledToolNames.length,
      filteredTools: Object.keys(filteredTools).length,
      excludedTools,
    },
    "Filtered tools by enabled IDs",
  );

  return filteredTools;
}
