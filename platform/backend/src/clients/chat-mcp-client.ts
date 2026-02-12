import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  isAgentTool,
  isArchestraMcpServerTool,
  isBrowserMcpTool,
  parseFullToolName,
  TimeInMs,
} from "@shared";
import { type JSONSchema7, jsonSchema, type Tool } from "ai";
import {
  type ArchestraContext,
  executeArchestraTool,
  getAgentTools,
} from "@/archestra-mcp-server";
import { CacheKey, LRUCacheManager } from "@/cache-manager";
import mcpClient from "@/clients/mcp-client";
import logger from "@/logging";
import {
  AgentTeamModel,
  TeamModel,
  TeamTokenModel,
  ToolModel,
  UserTokenModel,
} from "@/models";
import { metrics } from "@/observability";

/**
 * MCP Gateway base URL (internal)
 * Chat connects to the new MCP Gateway endpoint with profile ID in path
 */
const MCP_GATEWAY_BASE_URL = "http://localhost:9000/v1/mcp";

/**
 * Maximum client cache size to prevent unbounded memory growth.
 * Each entry is an MCP Client connection, which consumes resources.
 */
const MAX_CLIENT_CACHE_SIZE = 500;

/**
 * Client cache per agent + user combination using LRU eviction.
 * Key: `${agentId}:${userId}`, Value: MCP Client
 *
 * Uses onEviction callback to properly close() clients when evicted,
 * preventing connection leaks.
 */
const clientCache = new LRUCacheManager<Client>({
  maxSize: MAX_CLIENT_CACHE_SIZE,
  defaultTtl: 0, // No TTL - clients remain until evicted or manually removed
  onEviction: (key: string, client: unknown) => {
    try {
      (client as Client).close();
      logger.info({ cacheKey: key }, "Closed evicted MCP client connection");
    } catch (error) {
      logger.warn(
        { cacheKey: key, error },
        "Error closing evicted MCP client (non-fatal)",
      );
    }
  },
});

/**
 * Tool cache TTL - 30 seconds to avoid hammering MCP Gateway
 */
const TOOL_CACHE_TTL_MS = 30 * TimeInMs.Second;

/**
 * Maximum tool cache size to prevent unbounded memory growth.
 * With 30s TTL and typical conversation patterns, 1000 entries should handle
 * ~1000 concurrent conversations with comfortable headroom.
 */
const MAX_TOOL_CACHE_SIZE = 1000;

/**
 * In-memory tool cache per agent + user + prompt + conversation using LRU eviction.
 *
 * Note: This cannot use the distributed cacheManager because Tool objects contain
 * execute functions which cannot be serialized to PostgreSQL JSONB.
 *
 * For multi-pod deployments, sticky sessions should be used to ensure all
 * requests for a conversation hit the same pod. Without sticky sessions,
 * requests may be routed to different pods, causing frequent cache misses.
 * This degrades performance (repeated tool fetches from MCP Gateway) but
 * does not affect correctness - tools will still work, just slower.
 */
const toolCache = new LRUCacheManager<Record<string, Tool>>({
  maxSize: MAX_TOOL_CACHE_SIZE,
  defaultTtl: TOOL_CACHE_TTL_MS,
});

/**
 * Generate cache key from agentId, userId, and optional conversationId.
 * When conversationId is provided, each conversation gets its own MCP client
 * and therefore its own browser instance for proper isolation.
 */
function getCacheKey(
  agentId: string,
  userId: string,
  conversationId?: string,
): string {
  if (conversationId) {
    return `${agentId}:${userId}:${conversationId}`;
  }
  return `${agentId}:${userId}`;
}

/**
 * Generate the full cache key for tool cache
 * Includes conversationId because browser tools need correct tab selection
 */
function getToolCacheKey(
  agentId: string,
  userId: string,
  conversationId?: string,
): `${typeof CacheKey.ChatMcpTools}-${string}` {
  const baseKey = getCacheKey(agentId, userId);
  const parts = [baseKey];
  if (conversationId) parts.push(conversationId);
  return `${CacheKey.ChatMcpTools}-${parts.join(":")}`;
}

export const __test = {
  setCachedClient(cacheKey: string, client: Client) {
    clientCache.set(cacheKey, client, 0); // No TTL for clients
  },
  async clearToolCache(cacheKey?: string) {
    if (cacheKey) {
      toolCache.delete(`${CacheKey.ChatMcpTools}-${cacheKey}`);
    } else {
      toolCache.clear();
    }
  },
  getCacheKey,
  isBrowserMcpTool,
};

/**
 * Select the appropriate token for a user based on team overlap
 * Priority:
 * 1. Personal user token (always preferred - ensures userId is available for global catalog tools)
 * 2. Organization token (fallback for admins)
 * 3. Team token where user is a member AND team is assigned to profile
 *
 * @param agentId - The profile (agent) ID
 * @param userId - The user requesting access
 * @param userIsProfileAdmin - Whether the user has profile admin permission
 * @returns Token value and metadata, or null if no token available
 */
export async function selectMCPGatewayToken(
  agentId: string,
  userId: string,
  organizationId: string,
  userIsProfileAdmin: boolean,
): Promise<{
  tokenValue: string;
  tokenId: string;
  teamId: string | null;
  isOrganizationToken: boolean;
  isUserToken?: boolean;
} | null> {
  // Get user's team IDs and profile's team IDs (needed for fallback token selection)
  const userTeamIds = await TeamModel.getUserTeamIds(userId);
  const profileTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);
  const commonTeamIds = userTeamIds.filter((id) => profileTeamIds.includes(id));

  // 1. Always try to get/create a personal user token first
  // This ensures userId is available in the token for global catalog tools
  {
    // Ensure user has a token (creates one if missing)
    const userToken = await UserTokenModel.ensureUserToken(
      userId,
      organizationId,
    );
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
          "Using organization token for chat MCP client (fallback)",
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
            "Selected team-scoped token for chat MCP client (fallback)",
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
 * Clear cached client and tools for a specific agent (all users)
 * Should be called when MCP Gateway sessions are cleared
 *
 * @param agentId - The agent ID whose clients/tools should be cleared
 */
export function clearChatMcpClient(agentId: string): void {
  logger.info(
    { agentId },
    "clearChatMcpClient() called - checking for cached clients and tools",
  );

  let clientClearedCount = 0;
  let toolClearedCount = 0;

  // Find and remove all client cache entries for this agentId (any user)
  // Collect keys first to avoid iterator invalidation during deletion
  const clientKeysToDelete: string[] = [];
  for (const key of clientCache.keys()) {
    if (key.startsWith(`${agentId}:`)) {
      clientKeysToDelete.push(key);
    }
  }

  for (const key of clientKeysToDelete) {
    const client = clientCache.get(key);
    if (client) {
      try {
        client.close();
        logger.info({ agentId, cacheKey: key }, "Closed MCP client connection");
      } catch (error) {
        logger.warn(
          { agentId, cacheKey: key, error },
          "Error closing MCP client connection (non-fatal)",
        );
      }
      clientCache.delete(key);
      clientClearedCount++;
    }
  }

  // Clear tool cache entries for this agentId
  // Collect keys first to avoid iterator invalidation during deletion
  const toolKeysToDelete: string[] = [];
  for (const key of toolCache.keys()) {
    if (key.startsWith(`${CacheKey.ChatMcpTools}-${agentId}:`)) {
      toolKeysToDelete.push(key);
    }
  }

  for (const key of toolKeysToDelete) {
    toolCache.delete(key);
    toolClearedCount++;
  }

  logger.info(
    {
      agentId,
      clientClearedCount,
      toolClearedCount,
      remainingCachedClients: clientCache.size,
      remainingCachedTools: toolCache.size,
    },
    "Cleared MCP client and tool cache entries for agent",
  );
}

/**
 * Close and remove cached MCP client for a specific agent/user/conversation.
 * Should be called when browser stream unsubscribes to free resources.
 *
 * @param agentId - The agent (profile) ID
 * @param userId - The user ID
 * @param conversationId - The conversation ID
 */
export function closeChatMcpClient(
  agentId: string,
  userId: string,
  conversationId: string,
): void {
  const cacheKey = getCacheKey(agentId, userId, conversationId);
  const client = clientCache.get(cacheKey);
  if (client) {
    try {
      client.close();
      logger.info(
        { agentId, userId, conversationId, cacheKey },
        "Closed MCP client connection for conversation",
      );
    } catch (error) {
      logger.warn(
        { agentId, userId, conversationId, cacheKey, error },
        "Error closing MCP client connection (non-fatal)",
      );
    }
    clientCache.delete(cacheKey);
  }

  // Also clear tool cache for this conversation
  const toolCacheKey = getToolCacheKey(agentId, userId, conversationId);
  toolCache.delete(toolCacheKey);
}

/**
 * Get or create MCP client for the specified agent and user
 * Connects to internal MCP Gateway with team token authentication
 *
 * @param agentId - The agent (profile) ID
 * @param userId - The user ID for token selection
 * @param organizationId - The organization ID for token creation
 * @param userIsProfileAdmin - Whether the user is a profile admin
 * @param conversationId - Optional conversation ID for per-conversation browser isolation
 * @returns MCP Client connected to the gateway, or null if connection fails
 */
export async function getChatMcpClient(
  agentId: string,
  userId: string,
  organizationId: string,
  userIsProfileAdmin: boolean,
  conversationId?: string,
): Promise<Client | null> {
  const cacheKey = getCacheKey(agentId, userId, conversationId);

  // Check cache first
  const cachedClient = clientCache.get(cacheKey);
  if (cachedClient) {
    // Health check: ping the client to verify connection is still alive
    try {
      await cachedClient.ping();
      logger.info(
        { agentId, userId },
        "✅ Returning cached MCP client for agent/user (ping succeeded, session will be reused)",
      );
      return cachedClient;
    } catch (error) {
      // Connection is dead, invalidate cache and create fresh client
      logger.warn(
        {
          agentId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Cached MCP client ping failed, creating fresh client",
      );
      // Close the dead client before removing from cache to prevent resource leaks
      try {
        cachedClient.close();
      } catch (closeError) {
        logger.warn(
          { agentId, userId, closeError },
          "Error closing dead MCP client (non-fatal)",
        );
      }
      clientCache.delete(cacheKey);
      // Fall through to create new client
    }
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
    organizationId,
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

    // Cache the client (no TTL - clients remain until evicted or manually removed)
    clientCache.set(cacheKey, client, 0);

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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJsonSchema(schema: unknown): JSONSchema7 {
  const fallbackSchema: JSONSchema7 = { type: "object", properties: {} };

  // If schema is missing or invalid, return a minimal valid schema
  if (!isRecord(schema)) {
    return fallbackSchema;
  }

  const schemaType = schema.type;
  if (typeof schemaType !== "string") {
    return fallbackSchema;
  }

  if (schemaType === "None" || schemaType === "null") {
    return fallbackSchema;
  }

  // Return the schema as-is if it's already valid JSON Schema
  return schema as JSONSchema7;
}

/**
 * Get all MCP tools for the specified agent and user in AI SDK Tool format
 * Converts MCP JSON Schema to AI SDK Schema using jsonSchema() helper
 *
 * @param agentId - The agent ID to fetch tools for
 * @param userId - The user ID for authentication
 * @param organizationId - The organization ID for token creation
 * @param userIsProfileAdmin - Whether the user is a profile admin
 * @param enabledToolIds - Optional array of tool IDs to filter by. Empty array = all tools enabled.
 * @param conversationId - Optional conversation ID for browser tab selection
 * @returns Record of tool name to AI SDK Tool object
 */
export async function getChatMcpTools({
  agentName,
  agentId,
  userId,
  organizationId,
  userIsProfileAdmin,
  enabledToolIds,
  conversationId,
  sessionId,
  delegationChain,
  abortSignal,
}: {
  agentName: string;
  agentId: string;
  userId: string;
  organizationId: string;
  userIsProfileAdmin: boolean;
  enabledToolIds?: string[];
  conversationId?: string;
  /** Session ID for grouping related LLM requests in logs */
  sessionId?: string;
  /** Delegation chain of agent IDs for tracking delegated agent calls */
  delegationChain?: string;
  /** Optional cancellation signal from parent stream execution */
  abortSignal?: AbortSignal;
}): Promise<Record<string, Tool>> {
  const toolCacheKey = getToolCacheKey(agentId, userId, conversationId);
  const shouldUseToolCache = !abortSignal;

  // Check in-memory tool cache first (cannot use distributed cacheManager - Tool objects have execute functions)
  // LRU eviction and TTL are handled automatically by LRUCacheManager
  const cachedTools = shouldUseToolCache ? toolCache.get(toolCacheKey) : null;
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

  // Log cache miss - in multi-pod deployments without sticky sessions,
  // frequent cache misses indicate requests are being routed to different pods.
  // This degrades performance as tools need to be re-fetched from MCP Gateway.
  logger.info(
    {
      agentId,
      userId,
      conversationId,
      cacheSize: toolCache.size,
    },
    "Tool cache miss - fetching tools from MCP Gateway. If this happens frequently for the same conversation, check that sticky sessions are configured for your load balancer.",
  );

  // Get token for direct tool execution (bypasses HTTP for security)
  const mcpGwToken = await selectMCPGatewayToken(
    agentId,
    userId,
    organizationId,
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
  // Pass conversationId for per-conversation browser isolation
  const client = await getChatMcpClient(
    agentId,
    userId,
    organizationId,
    userIsProfileAdmin,
    conversationId,
  );

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

    // Filter out agent skills (tools starting with "agent__")
    const filteredMcpTools = mcpTools.filter((tool) => !isAgentTool(tool.name));

    logger.info(
      {
        agentId,
        userId,
        toolCount: filteredMcpTools.length,
        toolNames: filteredMcpTools.map((t) => t.name),
      },
      "Fetched tools from MCP Gateway for agent/user",
    );

    // Convert MCP tools to AI SDK Tool format
    const aiTools: Record<string, Tool> = {};

    for (const mcpTool of filteredMcpTools) {
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
          execute: async (args: unknown) => {
            logger.info(
              { agentId, userId, toolName: mcpTool.name, arguments: args },
              "Executing MCP tool from chat (direct)",
            );

            const toolArguments = isRecord(args) ? args : undefined;

            const toolStartTime = Date.now();

            try {
              throwIfAborted(abortSignal);
              // Check if this is an Archestra tool - handle directly without DB lookup
              if (isArchestraMcpServerTool(mcpTool.name)) {
                const archestraResponse = await executeArchestraTool(
                  mcpTool.name,
                  toolArguments,
                  {
                    agent: { id: agentId, name: agentName },
                    conversationId,
                    userId,
                    agentId,
                    organizationId,
                    sessionId,
                    abortSignal,
                  },
                );

                reportToolMetrics({
                  toolName: mcpTool.name,
                  agentName,
                  startTime: toolStartTime,
                  isError: archestraResponse.isError ?? false,
                });

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
                return (
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
              }

              // Execute non-Archestra tools via shared helper with browser sync
              return await executeMcpTool({
                toolName: mcpTool.name,
                toolArguments,
                agentId,
                agentName,
                userId,
                organizationId,
                userIsProfileAdmin,
                conversationId,
                mcpGwToken,
                abortSignal,
              });
            } catch (error) {
              reportToolMetrics({
                toolName: mcpTool.name,
                agentName,
                startTime: toolStartTime,
                isError: true,
              });
              const logPayload = {
                agentId,
                userId,
                toolName: mcpTool.name,
                err: error,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              };
              if (isAbortLikeError(error)) {
                logger.info(logPayload, "MCP tool execution aborted");
              } else {
                logger.error(logPayload, "MCP tool execution failed");
              }
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

    // Fetch and add agent delegation tools if organizationId is available
    if (organizationId) {
      try {
        const agentToolsList = await getAgentTools({
          agentId,
          organizationId,
          userId,
          skipAccessCheck: userIsProfileAdmin,
        });

        // Build the context for agent tool execution
        const archestraContext: ArchestraContext = {
          agent: { id: agentId, name: agentName },
          agentId,
          organizationId,
          conversationId,
          sessionId,
          // Pass delegation chain for tracking delegated agent calls
          delegationChain,
          abortSignal,
          tokenAuth: mcpGwToken
            ? {
                tokenId: mcpGwToken.tokenId,
                teamId: mcpGwToken.teamId,
                isOrganizationToken: mcpGwToken.isOrganizationToken,
                organizationId,
                isUserToken: mcpGwToken.isUserToken,
                userId: mcpGwToken.isUserToken ? userId : undefined,
              }
            : undefined,
        };

        // Convert agent tools to AI SDK Tool format
        for (const agentTool of agentToolsList) {
          const normalizedSchema = normalizeJsonSchema(agentTool.inputSchema);

          aiTools[agentTool.name] = {
            description:
              agentTool.description || `Agent tool: ${agentTool.name}`,
            inputSchema: jsonSchema(normalizedSchema),
            execute: async (args: Record<string, unknown>) => {
              logger.info(
                {
                  agentId,
                  userId,
                  toolName: agentTool.name,
                  arguments: args,
                },
                "Executing agent tool from chat",
              );

              const agentToolStartTime = Date.now();

              try {
                throwIfAborted(abortSignal);
                const response = await executeArchestraTool(
                  agentTool.name,
                  args,
                  archestraContext,
                );

                reportToolMetrics({
                  toolName: agentTool.name,
                  agentName,
                  startTime: agentToolStartTime,
                  isError: response.isError ?? false,
                });

                if (response.isError) {
                  const errorText = (
                    response.content as Array<{ type: string; text?: string }>
                  )
                    .map((item) =>
                      item.type === "text" && item.text
                        ? item.text
                        : JSON.stringify(item),
                    )
                    .join("\n");
                  throw new Error(errorText);
                }

                return (
                  response.content as Array<{ type: string; text?: string }>
                )
                  .map((item) =>
                    item.type === "text" && item.text
                      ? item.text
                      : JSON.stringify(item),
                  )
                  .join("\n");
              } catch (error) {
                reportToolMetrics({
                  toolName: agentTool.name,
                  agentName,
                  startTime: agentToolStartTime,
                  isError: true,
                });
                const logPayload = {
                  agentId,
                  userId,
                  toolName: agentTool.name,
                  err: error,
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                };
                if (isAbortLikeError(error)) {
                  logger.info(logPayload, "Agent tool execution aborted");
                } else {
                  logger.error(logPayload, "Agent tool execution failed");
                }
                throw error;
              }
            },
          };
        }

        logger.info(
          {
            agentId,
            userId,
            agentToolCount: agentToolsList.length,
            totalToolCount: Object.keys(aiTools).length,
          },
          "Added agent delegation tools to chat tools",
        );
      } catch (error) {
        logger.error(
          { agentId, userId, error },
          "Failed to fetch agent delegation tools, continuing without them",
        );
      }
    }

    // Cache tools in-memory (LRU eviction and TTL handled by LRUCacheManager)
    if (shouldUseToolCache) {
      toolCache.set(toolCacheKey, aiTools);
    }

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
 * Context for MCP tool execution with browser sync support.
 */
interface ToolExecutionContext {
  toolName: string;
  toolArguments: Record<string, unknown> | undefined;
  agentId: string;
  agentName: string;
  userId: string;
  organizationId: string;
  userIsProfileAdmin: boolean;
  conversationId?: string;
  mcpGwToken: {
    tokenId: string;
    teamId: string | null;
    isOrganizationToken: boolean;
  } | null;
  abortSignal?: AbortSignal;
}

/**
 * Shared helper for executing MCP tools with browser state synchronization.
 * Handles:
 * - Browser tab selection for browser tools
 * - MCP tool execution via mcpClient
 * - Browser state sync (tabs and navigation)
 * - Content conversion to string format
 *
 * @returns The tool result as a string
 * @throws Error if tool execution fails
 */
async function executeMcpTool(ctx: ToolExecutionContext): Promise<string> {
  const {
    toolName,
    toolArguments,
    agentId,
    agentName,
    userId,
    organizationId,
    userIsProfileAdmin,
    conversationId,
    mcpGwToken,
    abortSignal,
  } = ctx;
  throwIfAborted(abortSignal);
  const startTime = Date.now();

  // For browser tools, ensure the correct conversation tab is selected first
  const { browserStreamFeature } = await import(
    "@/features/browser-stream/services/browser-stream.feature"
  );

  if (
    conversationId &&
    isBrowserMcpTool(toolName) &&
    browserStreamFeature.isEnabled()
  ) {
    logger.debug(
      { agentId, userId, conversationId, toolName },
      "Selecting conversation browser tab before executing browser tool",
    );

    const tabResult = await browserStreamFeature.selectOrCreateTab(
      agentId,
      conversationId,
      { userId, organizationId, userIsProfileAdmin },
    );

    if (!tabResult.success) {
      logger.warn(
        { agentId, conversationId, toolName, error: tabResult.error },
        "Failed to select conversation tab for browser tool, continuing anyway",
      );
    }
  }

  // Execute via mcpClient
  const toolCall = {
    id: randomUUID(),
    name: toolName,
    arguments: toolArguments ?? {},
  };

  let result: Awaited<ReturnType<typeof mcpClient.executeToolCall>>;
  try {
    result = await mcpClient.executeToolCall(
      toolCall,
      agentId,
      mcpGwToken
        ? {
            tokenId: mcpGwToken.tokenId,
            teamId: mcpGwToken.teamId,
            isOrganizationToken: mcpGwToken.isOrganizationToken,
            organizationId,
            userId,
          }
        : undefined,
      { conversationId },
    );
    reportToolMetrics({
      toolName,
      agentName,
      startTime,
      isError: result.isError ?? false,
    });
  } catch (error) {
    reportToolMetrics({ toolName, agentName, startTime, isError: true });
    throw error;
  }
  throwIfAborted(abortSignal);

  // Check if MCP tool returned an error
  if (result.isError) {
    const extractedError = Array.isArray(result.content)
      ? result.content
          .map((item: { type: string; text?: string }) =>
            item.type === "text" && item.text
              ? item.text
              : JSON.stringify(item),
          )
          .join("\n")
      : null;
    const errorMessage =
      extractedError || result.error || "Tool execution failed";
    throw new Error(errorMessage);
  }

  // Sync browser state if needed
  logger.debug(
    { conversationId, toolName, isEnabled: browserStreamFeature.isEnabled() },
    "[executeMcpTool] Checking browser sync conditions",
  );
  if (conversationId && browserStreamFeature.isEnabled()) {
    // Sync URL for browser_navigate (but not browser_navigate_back/forward)
    const isNavigateTool =
      toolName.endsWith("browser_navigate") ||
      toolName.endsWith("__navigate") ||
      (toolName.includes("playwright") &&
        toolName.includes("navigate") &&
        !toolName.includes("_back") &&
        !toolName.includes("_forward"));
    logger.debug(
      { toolName, isNavigateTool, conversationId },
      "[executeMcpTool] Checking navigate sync condition",
    );
    if (isNavigateTool) {
      logger.info(
        { toolName, agentId, conversationId },
        "[executeMcpTool] Syncing URL from navigate tool call",
      );
      await browserStreamFeature.syncUrlFromNavigateToolCall({
        agentId,
        conversationId,
        userContext: { userId, organizationId, userIsProfileAdmin },
        toolResultContent: result.content,
      });
    }
  }

  // Convert MCP content to string for AI SDK
  return (result.content as Array<{ type: string; text?: string }>)
    .map((item: { type: string; text?: string }) => {
      if (item.type === "text" && item.text) {
        return item.text;
      }
      return JSON.stringify(item);
    })
    .join("\n");
}

/**
 * Filter tools by enabled tool IDs
 * If enabledToolIds is undefined, returns all tools (no custom selection = all enabled)
 * If enabledToolIds is empty array, returns no tools (explicit selection of zero tools)
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
  // undefined = no custom selection, return all tools (default behavior)
  if (enabledToolIds === undefined) {
    logger.info(
      {
        totalTools: Object.keys(tools).length,
        reason: "undefined - no custom selection",
      },
      "No tool filtering applied - all tools enabled by default",
    );
    return tools;
  }

  // Empty array = explicit selection of zero tools
  if (enabledToolIds.length === 0) {
    logger.info(
      {
        totalTools: Object.keys(tools).length,
        enabledToolIds: 0,
        reason: "empty array - all tools explicitly disabled",
      },
      "All tools filtered out - user disabled all tools",
    );
    return {};
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

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (!abortSignal?.aborted) {
    return;
  }

  const abortError = new Error("Chat execution aborted");
  abortError.name = "AbortError";
  throw abortError;
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  return error.message.toLowerCase().includes("abort");
}

function reportToolMetrics(params: {
  toolName: string;
  agentName: string;
  startTime: number;
  isError: boolean;
}): void {
  const { serverName } = parseFullToolName(params.toolName);
  metrics.mcp.reportMcpToolCall({
    profileName: params.agentName,
    mcpServerName: serverName ?? "unknown",
    toolName: params.toolName,
    durationSeconds: (Date.now() - params.startTime) / 1000,
    isError: params.isError,
  });
}
