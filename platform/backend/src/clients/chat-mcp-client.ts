import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, type Tool } from "ai";
import mcpClient from "@/clients/mcp-client";
import logger from "@/logging";
import { AgentTeamModel, ProfileTokenModel, TeamModel } from "@/models";
import { secretManager } from "@/secretsmanager";

/**
 * MCP Gateway base URL (internal)
 * Chat connects to the new MCP Gateway endpoint with profile ID in path
 */
const MCP_GATEWAY_BASE_URL = "http://localhost:9000/v1/mcp";

/**
 * Client cache per agent + user combination
 * Key: `${agentId}:${userId}`, Value: MCP Client
 */
const clientCache = new Map<string, Client>();

/**
 * Tool cache per agent + user with TTL to avoid hammering MCP Gateway
 */
const TOOL_CACHE_TTL_MS = 30_000; // 30 seconds
const toolCache = new Map<
  string,
  { tools: Record<string, Tool>; expiresAt: number }
>();

/**
 * Generate cache key from agentId and userId
 */
function getCacheKey(agentId: string, userId: string): string {
  return `${agentId}:${userId}`;
}

export const __test = {
  setCachedClient(cacheKey: string, client: Client) {
    clientCache.set(cacheKey, client);
  },
  clearToolCache(cacheKey?: string) {
    if (cacheKey) {
      toolCache.delete(cacheKey);
    } else {
      toolCache.clear();
    }
  },
  getCacheKey,
};

/**
 * Select the appropriate profile token for a user based on team overlap
 * Priority:
 * 1. Team-scoped token where user is a member of that team AND team is assigned to profile
 * 2. Organization token (fallback)
 *
 * @param agentId - The profile (agent) ID
 * @param userId - The user requesting access
 * @returns Token value and metadata, or null if no token available
 */
async function selectProfileToken(
  agentId: string,
  userId: string,
  userIsProfileAdmin: boolean,
): Promise<{
  tokenValue: string;
  tokenId: string;
  teamId: string | null;
  isOrganizationToken: boolean;
} | null> {
  // Get user's team IDs
  const userTeamIds = await TeamModel.getUserTeamIds(userId);

  // Get profile's team IDs
  const profileTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);

  // Find intersection of user's teams and profile's teams
  const commonTeamIds = userTeamIds.filter((id) => profileTeamIds.includes(id));

  // Get all tokens for the profile
  const tokens = await ProfileTokenModel.findByProfileId(agentId);

  // if user is profile admin, use organization token which allow him to use token from any team
  const orgToken = tokens.find((t) => t.isOrganizationToken);
  if (userIsProfileAdmin && orgToken) {
    const secret = await secretManager.getSecret(orgToken.secretId);
    if (secret?.secret) {
      const tokenValue = (secret.secret as { token?: string }).token;
      if (tokenValue) {
        logger.info(
          {
            agentId,
            userId,
            tokenId: orgToken.id,
          },
          "Using organization token for chat MCP client (no matching team token)",
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

  // Otherwise, try to find a team-scoped token first (where user is in that team)
  if (commonTeamIds.length > 0) {
    for (const token of tokens) {
      if (token.teamId && commonTeamIds.includes(token.teamId)) {
        // Found a team token where user is in that team
        const secret = await secretManager.getSecret(token.secretId);
        if (secret?.secret) {
          const tokenValue = (secret.secret as { token?: string }).token;
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
    "No valid profile token found for user",
  );

  return null;
}

/**
 * Clear cached client for a specific agent (all users)
 * Should be called when MCP Gateway sessions are cleared
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

  // Clear tool cache entries for this agentId
  for (const key of toolCache.keys()) {
    if (key.startsWith(`${agentId}:`)) {
      toolCache.delete(key);
    }
  }

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
 * Connects to internal MCP Gateway with profile token authentication
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
  const tokenResult = await selectProfileToken(
    agentId,
    userId,
    userIsProfileAdmin,
  );
  if (!tokenResult) {
    logger.error(
      { agentId, userId },
      "No valid profile token available for user - cannot connect to MCP Gateway",
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
 * @returns Record of tool name to AI SDK Tool object
 */
export async function getChatMcpTools(
  agentId: string,
  userId: string,
  userIsProfileAdmin: boolean,
): Promise<Record<string, Tool>> {
  const cacheKey = getCacheKey(agentId, userId);

  const cachedTools = toolCache.get(cacheKey);
  if (cachedTools && cachedTools.expiresAt > Date.now()) {
    logger.info(
      {
        agentId,
        userId,
        toolCount: Object.keys(cachedTools.tools).length,
      },
      "Returning cached MCP tools for chat",
    );
    return cachedTools.tools;
  } else if (cachedTools) {
    toolCache.delete(cacheKey);
  }

  logger.info(
    { agentId, userId },
    "getChatMcpTools() called - fetching client...",
  );

  // Get token for direct tool execution (bypasses HTTP for security)
  const profileToken = await selectProfileToken(
    agentId,
    userId,
    userIsProfileAdmin,
  );
  if (!profileToken) {
    logger.warn(
      { agentId, userId },
      "No valid profile token available for user - cannot execute tools",
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
              // Execute tool directly via mcpClient to avoid the need to pass the token in the HTTP header
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
                  tokenId: profileToken.tokenId,
                  tokenTeamId: profileToken.teamId,
                  isOrganizationToken: profileToken.isOrganizationToken,
                  userId, // Pass userId for user-owned server priority
                },
              );

              logger.info(
                { agentId, userId, toolName: mcpTool.name, result },
                "MCP tool execution completed (direct)",
              );

              // Check if MCP tool returned an error first
              // When isError is true, throw to signal AI SDK that tool execution failed
              // This allows AI SDK to create a tool-error part and continue the conversation
              // Use result.error (not result.content which is null for errors)
              if (result.isError) {
                throw new Error(result.error || "Tool execution failed");
              }

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
                { agentId, userId, toolName: mcpTool.name, error },
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

    toolCache.set(cacheKey, {
      tools: aiTools,
      expiresAt: Date.now() + TOOL_CACHE_TTL_MS,
    });

    return aiTools;
  } catch (error) {
    logger.error(
      { agentId, userId, error },
      "Failed to fetch tools from MCP Gateway",
    );
    return {};
  }
}
