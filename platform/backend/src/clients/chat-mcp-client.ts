import { randomUUID } from "node:crypto";
import {
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
  type McpUiToolMeta,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ContentBlock,
  EmbeddedResource,
} from "@modelcontextprotocol/sdk/types.js";
import {
  isAgentTool,
  isBrowserMcpTool,
  MCP_APPS_CLIENT_EXTENSION_CAPABILITIES,
  parseFullToolName,
  TimeInMs,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
} from "@shared";
import { type JSONSchema7, jsonSchema, type Tool } from "ai";
import { evaluateToolExecutionContextTrust } from "@/agents/context-trust";
import {
  type ArchestraContext,
  archestraMcpBranding,
  executeArchestraTool,
  getAgentTools,
} from "@/archestra-mcp-server";
import { CacheKey, LRUCacheManager } from "@/cache-manager";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  OrganizationModel,
  TeamModel,
  TeamTokenModel,
  ToolModel,
  TrustedDataPolicyModel,
  UserTokenModel,
} from "@/models";
import ToolInvocationPolicyModel from "@/models/tool-invocation-policy";
import { metrics } from "@/observability";
import {
  ATTR_MCP_IS_ERROR_RESULT,
  startActiveMcpSpan,
} from "@/observability/tracing";
import { resolveSessionExternalIdpToken } from "@/services/identity-providers/session-token";
import type {
  AgentType,
  GlobalToolPolicy,
  UnsafeContextBoundary,
} from "@/types";
import { UNSAFE_CONTEXT_BOUNDARY_REASON } from "@/types";
import type { ClientCapabilitiesWithExtensions } from "@/types/mcp-capabilities";
import { buildMcpClientInfo } from "@/utils/mcp-client-info";

/**
 * MIME types that indicate a renderable UI resource (SEP-1865).
 * `text/html;profile=mcp-app` is the canonical type per the spec;
 */
const RENDERABLE_UI_MIME_TYPES = [RESOURCE_MIME_TYPE];

/**
 * MCP Gateway base URL (internal)
 * Chat connects to the MCP Gateway endpoint with profile ID in path.
 * Derives from the configured API port to work in multi-pod deployments.
 */
const MCP_GATEWAY_BASE_URL = `http://localhost:${config.api.port}/v1/mcp`;

// Idle TTL for conversation-scoped MCP clients. These sessions are expensive
// enough that we do not want them to linger forever after a chat/browser tab
// is abandoned, but they should survive normal pauses within an active session.
// Fifteen minutes is long enough to avoid thrashing during typical chat usage
// while still reclaiming orphaned browser/MCP state within the same workday.
const CHAT_MCP_CLIENT_IDLE_TTL_MS = 15 * TimeInMs.Minute;

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
  defaultTtl: CHAT_MCP_CLIENT_IDLE_TTL_MS,
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
const CLIENT_PING_TIMEOUT_MS = 5 * TimeInMs.Second;

function getChatExternalAgentId(): string {
  return `${archestraMcpBranding.catalogName} Chat`;
}

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
 * UI resource cache TTL — 60 seconds.
 * UI resources (MCP App HTML) rarely change during a conversation, so a
 * generous TTL avoids repeated round-trips through the MCP gateway.
 */
const UI_RESOURCE_CACHE_TTL_MS = 60 * TimeInMs.Second;

const uiResourceCache = new LRUCacheManager<ToolUiResourceData | null>({
  maxSize: 500,
  defaultTtl: UI_RESOURCE_CACHE_TTL_MS,
});

/** @public — exported for testability (test cleanup) */
export function clearUiResourceCache(): void {
  uiResourceCache.clear();
}

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

/** @public — exported for testability */
export const __test = {
  setCachedClient(cacheKey: string, client: Client, ttl?: number) {
    clientCache.set(cacheKey, client, ttl);
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
  normalizeJsonSchema,
  executeMcpTool,
  filterToolsByEnabledIds,
  pingClientWithTimeout,
  throwIfApprovalRequired,
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
 * @returns Token value and metadata, or null if no token available
 */
export async function selectMCPGatewayToken(
  agentId: string,
  userId: string,
  organizationId: string,
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
  // Skip when userId is "system" (e.g., internal/public email security modes)
  // since "system" is not a real user and cannot have a user token
  if (userId !== "system") {
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

  // Get all team tokens for this organization
  const tokens = await TeamTokenModel.findAll(organizationId);

  // 2. System user has no team memberships so it can never match a team token.
  //    Fall back to the organization token to preserve tool access.
  if (userId === "system") {
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
 * Connects to the internal MCP Gateway using either a session-derived external
 * IdP JWT or the existing internal gateway token fallback.
 *
 * @param agentId - The agent (profile) ID
 * @param userId - The user ID for token selection
 * @param organizationId - The organization ID for token creation
 * @param conversationId - Optional conversation ID for per-conversation browser isolation
 * @returns MCP Client connected to the gateway, or null if connection fails
 * @public — exported for testability
 */
export async function getChatMcpClient(
  agentId: string,
  userId: string,
  organizationId: string,
  conversationId?: string,
  /** Pre-resolved token to avoid a redundant selectMCPGatewayToken call */
  preResolvedTokenValue?: string,
): Promise<Client | null> {
  const cacheKey = getCacheKey(agentId, userId, conversationId);

  // Check cache first
  const cachedClient = clientCache.get(cacheKey);
  if (cachedClient) {
    // Health check: ping the client to verify connection is still alive
    try {
      await pingClientWithTimeout(cachedClient);
      logger.info(
        { agentId, userId },
        "Returning cached MCP client for agent/user (ping succeeded, session will be reused)",
      );
      clientCache.set(cacheKey, cachedClient);
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
    "No cached client found - creating new MCP client for agent/user via gateway",
  );

  const externalIdpToken = await resolveSessionExternalIdpToken({
    agentId,
    userId,
  });

  // Reuse pre-resolved token when available to avoid a redundant DB round-trip
  // (getChatMcpTools already calls selectMCPGatewayToken before this).
  let tokenValue: string;
  let fallbackTokenValue: string | null = null;
  if (externalIdpToken) {
    tokenValue = externalIdpToken.rawToken;
    fallbackTokenValue = preResolvedTokenValue ?? null;
    logger.info(
      {
        agentId,
        userId,
        identityProviderId: externalIdpToken.identityProviderId,
        providerId: externalIdpToken.providerId,
      },
      "Using session-derived external IdP token for chat MCP client",
    );
  } else if (preResolvedTokenValue) {
    tokenValue = preResolvedTokenValue;
  } else {
    const tokenResult = await selectMCPGatewayToken(
      agentId,
      userId,
      organizationId,
    );
    if (!tokenResult) {
      logger.error(
        { agentId, userId },
        "No valid token available for user - cannot connect to MCP Gateway",
      );
      return null;
    }
    tokenValue = tokenResult.tokenValue;
  }

  // Use new URL format with profileId in path
  const mcpGatewayUrl = `${MCP_GATEWAY_BASE_URL}/${agentId}`;

  const connectWithToken = async (authToken: string) => {
    // Create StreamableHTTP transport with profile token authentication
    const transport = new StreamableHTTPClientTransport(
      new URL(mcpGatewayUrl),
      {
        requestInit: {
          headers: new Headers({
            Authorization: `Bearer ${authToken}`,
            Accept: "application/json, text/event-stream",
          }),
        },
      },
    );

    const capabilities: ClientCapabilitiesWithExtensions = {
      roots: { listChanged: true },
      extensions: MCP_APPS_CLIENT_EXTENSION_CAPABILITIES,
    };

    // Create MCP client
    const client = new Client(buildMcpClientInfo("chat-mcp-client"), {
      capabilities,
    });

    logger.info(
      { agentId, userId, url: mcpGatewayUrl },
      "Connecting to MCP Gateway...",
    );
    await client.connect(transport);
    return client;
  };

  try {
    const client = await connectWithToken(tokenValue);

    logger.info(
      { agentId, userId },
      "Successfully connected to MCP Gateway (new session initialized)",
    );

    // Cache the client with idle expiration to prevent abandoned
    // conversation-scoped sessions from accumulating indefinitely.
    clientCache.set(cacheKey, client);

    logger.info(
      {
        agentId,
        userId,
        totalCachedClients: clientCache.size,
      },
      "MCP client cached - subsequent requests will reuse this session",
    );

    return client;
  } catch (error) {
    if (fallbackTokenValue) {
      logger.warn(
        {
          error,
          agentId,
          userId,
          url: mcpGatewayUrl,
        },
        "Failed to connect to MCP Gateway with session-derived external IdP token; retrying with internal gateway token",
      );

      try {
        const client = await connectWithToken(fallbackTokenValue);

        logger.info(
          { agentId, userId },
          "Successfully connected to MCP Gateway with internal gateway token fallback",
        );

        clientCache.set(cacheKey, client);

        logger.info(
          {
            agentId,
            userId,
            totalCachedClients: clientCache.size,
          },
          "MCP client cached - subsequent requests will reuse this session",
        );

        return client;
      } catch (fallbackError) {
        logger.error(
          { error: fallbackError, agentId, userId, url: mcpGatewayUrl },
          "Failed to connect to MCP Gateway for agent/user with fallback token",
        );
        return null;
      }
    }

    logger.error(
      { error, agentId, userId, url: mcpGatewayUrl },
      "Failed to connect to MCP Gateway for agent/user",
    );
    return null;
  }
}

async function pingClientWithTimeout(
  client: Pick<Client, "ping">,
  timeoutMs = CLIENT_PING_TIMEOUT_MS,
): Promise<void> {
  await Promise.race([
    client.ping(),
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Ping timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
    }),
  ]);
}

/**
 * Validate and normalize JSON Schema for OpenAI
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJsonSchema(schema: unknown): JSONSchema7 {
  const fallbackSchema: JSONSchema7 = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

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

  // Add additionalProperties: false to all object-type schemas recursively.
  // This is required for OpenAI-compatible providers (Ollama, vLLM) to properly
  // emit streaming tool calls instead of outputting tool calls as text content.
  // Without it, models hallucinate extra properties and providers may fail to
  // recognize the output as a tool call in streaming mode.
  return addAdditionalPropertiesFalse(schema) as JSONSchema7;
}

/**
 * Recursively adds `additionalProperties: false` to all object-type schemas.
 * Traverses properties, array items, and nested schemas.
 */
function addAdditionalPropertiesFalse(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...schema };

  if (result.type === "object") {
    if (!("additionalProperties" in result)) {
      result.additionalProperties = false;
    }

    // Recurse into properties
    if (isRecord(result.properties)) {
      const newProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result.properties)) {
        newProps[key] = isRecord(value)
          ? addAdditionalPropertiesFalse(value)
          : value;
      }
      result.properties = newProps;
    }
  }

  // Recurse into array items
  if (result.type === "array" && isRecord(result.items)) {
    result.items = addAdditionalPropertiesFalse(result.items);
  }

  return result;
}

/**
 * Get all MCP tools for the specified agent and user in AI SDK Tool format
 * Converts MCP JSON Schema to AI SDK Schema using jsonSchema() helper
 *
 * @param agentId - The agent ID to fetch tools for
 * @param userId - The user ID for authentication
 * @param organizationId - The organization ID for token creation
 * @param enabledToolIds - Optional array of tool IDs to filter by. Empty array = all tools enabled.
 * @param conversationId - Optional conversation ID for browser tab selection
 * @returns Record of tool name to AI SDK Tool object
 */
export async function getChatMcpTools({
  agentName,
  agentId,
  userId,
  organizationId,
  chatOpsBindingId,
  chatOpsThreadId,
  enabledToolIds,
  conversationId,
  sessionId,
  delegationChain,
  abortSignal,
  user,
  blockOnApprovalRequired,
  scheduleTriggerRunId,
}: {
  agentName: string;
  agentId: string;
  userId: string;
  organizationId: string;
  /** ChatOps channel binding ID for Slack/MS Teams-triggered executions */
  chatOpsBindingId?: string;
  /** ChatOps thread identifier for thread-scoped agent overrides */
  chatOpsThreadId?: string;
  enabledToolIds?: string[];
  conversationId?: string;
  /** Session ID for grouping related LLM requests in logs */
  sessionId?: string;
  /** Delegation chain of agent IDs for tracking delegated agent calls */
  delegationChain?: string;
  /** Optional cancellation signal from parent stream execution */
  abortSignal?: AbortSignal;
  /** User identity for OTEL span attributes */
  user?: { id: string; email?: string; name?: string };
  /** Block tool execution when policy is require_approval (for A2A/autonomous contexts where no one can approve) */
  blockOnApprovalRequired?: boolean;
  /** Schedule trigger run ID — enables artifact_write to target the run */
  scheduleTriggerRunId?: string;
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
  );
  if (!mcpGwToken) {
    logger.warn(
      { agentId, userId },
      "No valid team token available for user - cannot execute tools",
    );
    return {};
  }

  // Still use MCP client for listing tools (via MCP Gateway)
  // Pass conversationId for per-conversation browser isolation.
  // Forward the already-resolved token to avoid a duplicate selectMCPGatewayToken call.
  const client = await getChatMcpClient(
    agentId,
    userId,
    organizationId,
    conversationId,
    mcpGwToken.tokenValue,
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

    // Filter out agent skills and app-only tools.
    // Tools with _meta.ui.visibility that does not include "model" are intended
    // for app-iframe use only and must not appear in the LLM's tool list.
    // Default (no visibility field) = visible to both model and app.
    const filteredMcpTools = mcpTools.filter((tool) => {
      if (isAgentTool(tool.name)) return false;
      const uiVisibility = (tool._meta as { ui?: McpUiToolMeta } | undefined)
        ?.ui?.visibility;
      return !(uiVisibility && !uiVisibility.includes("model"));
    });

    logger.info(
      {
        agentId,
        userId,
        toolCount: filteredMcpTools.length,
        toolNames: filteredMcpTools.map((t) => t.name),
      },
      "Fetched tools from MCP Gateway for agent/user",
    );

    // Fetch globalToolPolicy for approval checks (needed for both chat and autonomous contexts).
    const [org, agent] = await Promise.all([
      OrganizationModel.getById(organizationId),
      AgentModel.findById(agentId),
    ]);
    const globalToolPolicy: GlobalToolPolicy =
      org?.globalToolPolicy ?? "permissive";
    const considerContextUntrusted = agent?.considerContextUntrusted ?? false;

    // Convert MCP tools to AI SDK Tool format
    const aiTools: Record<string, Tool> = {};

    for (const mcpTool of filteredMcpTools) {
      try {
        // Normalize the schema and wrap with jsonSchema() helper
        const normalizedSchema = normalizeJsonSchema(mcpTool.inputSchema);

        // Construct Tool using jsonSchema() to wrap JSON Schema
        aiTools[mcpTool.name] = {
          description: mcpTool.description || `Tool: ${mcpTool.name}`,
          inputSchema: jsonSchema(normalizedSchema),
          ...(!blockOnApprovalRequired
            ? {
                needsApproval: async (args: unknown) => {
                  return ToolInvocationPolicyModel.checkApprovalRequired(
                    mcpTool.name,
                    isRecord(args) ? args : {},
                    {
                      teamIds: [],
                      externalAgentId: getChatExternalAgentId(),
                    },
                    globalToolPolicy,
                  );
                },
              }
            : {}),
          execute: async (args: unknown) => {
            if (blockOnApprovalRequired) {
              await throwIfApprovalRequired(
                mcpTool.name,
                args,
                globalToolPolicy,
              );
            }

            logger.info(
              { agentId, userId, toolName: mcpTool.name, arguments: args },
              "Executing MCP tool from chat (direct)",
            );

            const toolArguments = isRecord(args) ? args : undefined;
            const { serverName } = parseFullToolName(mcpTool.name);

            const toolStartTime = Date.now();

            return startActiveMcpSpan({
              toolName: mcpTool.name,
              mcpServerName: serverName ?? "unknown",
              agent: { id: agentId, name: agentName },
              sessionId,
              toolArgs: toolArguments,
              user,
              callback: async (span) => {
                try {
                  throwIfAborted(abortSignal);
                  // Check if this is an Archestra tool - handle directly without DB lookup
                  if (archestraMcpBranding.isToolName(mcpTool.name)) {
                    logger.debug(
                      {
                        toolName: mcpTool.name,
                        scheduleTriggerRunId: scheduleTriggerRunId ?? null,
                        conversationId: conversationId ?? null,
                      },
                      "Executing archestra tool with context",
                    );
                    const archestraResponse = await executeArchestraTool(
                      mcpTool.name,
                      toolArguments,
                      {
                        agent: { id: agentId, name: agentName },
                        conversationId,
                        chatOpsBindingId,
                        chatOpsThreadId,
                        userId,
                        agentId,
                        organizationId,
                        sessionId,
                        scheduleTriggerRunId,
                        abortSignal,
                        tokenAuth: buildTokenAuthContext({
                          mcpGwToken,
                          organizationId,
                          userId,
                        }),
                      },
                    );

                    span.setAttribute(
                      ATTR_MCP_IS_ERROR_RESULT,
                      archestraResponse.isError ?? false,
                    );
                    reportToolMetrics({
                      toolName: mcpTool.name,
                      agentId,
                      agentName,
                      startTime: toolStartTime,
                      isError: archestraResponse.isError ?? false,
                    });

                    // Check for errors
                    if (archestraResponse.isError) {
                      const errorText = archestraResponse.content
                        .map((item) =>
                          item.type === "text"
                            ? item.text
                            : JSON.stringify(item),
                        )
                        .join("\n");
                      throw new Error(errorText);
                    }

                    // Convert MCP content to string for AI SDK
                    return archestraResponse.content
                      .map((item) =>
                        item.type === "text" ? item.text : JSON.stringify(item),
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
                    conversationId,
                    mcpGwToken,
                    globalToolPolicy,
                    considerContextUntrusted,
                    abortSignal,
                  });
                } catch (error) {
                  reportToolMetrics({
                    toolName: mcpTool.name,
                    agentId,
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
            });
          },
          // Strip UI-only fields (structuredContent, rawContent, _meta) so the LLM
          // only receives the plain-text `content` summary (SEP-1865).
          toModelOutput: mcpToolToModelOutput,
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
          skipAccessCheck: userId === "system",
        });

        // Build the context for agent tool execution
        const archestraContext: ArchestraContext = {
          agent: { id: agentId, name: agentName },
          agentId,
          organizationId,
          conversationId,
          chatOpsBindingId,
          chatOpsThreadId,
          sessionId,
          scheduleTriggerRunId,
          // Pass delegation chain for tracking delegated agent calls
          delegationChain,
          abortSignal,
          tokenAuth: buildTokenAuthContext({
            mcpGwToken,
            organizationId,
            userId,
          }),
        };

        // Convert agent tools to AI SDK Tool format
        for (const agentTool of agentToolsList) {
          const normalizedSchema = normalizeJsonSchema(agentTool.inputSchema);

          aiTools[agentTool.name] = {
            description:
              agentTool.description || `Agent tool: ${agentTool.name}`,
            inputSchema: jsonSchema(normalizedSchema),
            ...(!blockOnApprovalRequired
              ? {
                  needsApproval: async (args: unknown) => {
                    return ToolInvocationPolicyModel.checkApprovalRequired(
                      agentTool.name,
                      isRecord(args) ? args : {},
                      {
                        teamIds: [],
                        externalAgentId: getChatExternalAgentId(),
                      },
                      globalToolPolicy,
                    );
                  },
                }
              : {}),
            execute: async (args: Record<string, unknown>, options) => {
              if (blockOnApprovalRequired) {
                await throwIfApprovalRequired(
                  agentTool.name,
                  args,
                  globalToolPolicy,
                );
              }

              logger.info(
                {
                  agentId,
                  userId,
                  toolName: agentTool.name,
                  arguments: args,
                },
                "Executing agent tool from chat",
              );

              const { serverName: agentServerName } = parseFullToolName(
                agentTool.name,
              );
              const agentToolStartTime = Date.now();

              return startActiveMcpSpan({
                toolName: agentTool.name,
                mcpServerName: agentServerName ?? "unknown",
                agent: { id: agentId, name: agentName },
                sessionId,
                toolArgs: args,
                user,
                callback: async (span) => {
                  try {
                    throwIfAborted(abortSignal);
                    const toolExecutionContext =
                      await evaluateToolExecutionContextTrust({
                        messages: options.messages,
                        agentId,
                        organizationId,
                        userId,
                        considerContextUntrusted,
                        globalToolPolicy,
                        policyContext: {
                          externalAgentId: getChatExternalAgentId(),
                        },
                      });
                    const response = await executeArchestraTool(
                      agentTool.name,
                      args,
                      {
                        ...archestraContext,
                        contextIsTrusted: toolExecutionContext.contextIsTrusted,
                      },
                    );

                    span.setAttribute(
                      ATTR_MCP_IS_ERROR_RESULT,
                      response.isError ?? false,
                    );
                    reportToolMetrics({
                      toolName: agentTool.name,
                      agentId,
                      agentName,
                      startTime: agentToolStartTime,
                      isError: response.isError ?? false,
                    });

                    if (response.isError) {
                      const errorText = response.content
                        .map((item) =>
                          item.type === "text"
                            ? item.text
                            : JSON.stringify(item),
                        )
                        .join("\n");
                      throw new Error(errorText);
                    }

                    return response.content
                      .map((item) =>
                        item.type === "text" ? item.text : JSON.stringify(item),
                      )
                      .join("\n");
                  } catch (error) {
                    reportToolMetrics({
                      toolName: agentTool.name,
                      agentId,
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
              });
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
 * Converts the rich output of `executeMcpTool` into a plain text model output.
 * Strips UI-only fields (structuredContent, rawContent, _meta) so the LLM
 * only receives the plain-text `content` summary (SEP-1865).
 * @public — exported for testability
 */
export function mcpToolToModelOutput({
  output,
}: {
  output:
    | string
    | {
        content: string;
        _meta?: unknown;
        structuredContent?: unknown;
        rawContent?: unknown;
      };
}): { type: "text"; value: string } {
  return {
    type: "text",
    value: typeof output === "string" ? output : output.content,
  };
}

/** Pre-fetched UI resource data delivered via `data-tool-ui-start` SSE events. */
export interface ToolUiResourceData {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

/**
 * Returns a map of tool name → UI resource URI for every MCP App tool assigned
 * to an agent. Used to emit `data-tool-ui-start` SSE events as soon as a tool
 * call begins streaming so the frontend can render the app iframe immediately.
 */
export async function getChatMcpToolUiResourceUris(
  agentId: string,
): Promise<Record<string, string>> {
  try {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const result: Record<string, string> = {};
    for (const tool of tools) {
      const uriFromMeta = (
        tool.meta as { _meta?: { ui?: McpUiToolMeta } } | undefined
      )?._meta?.ui?.resourceUri;
      if (uriFromMeta) {
        result[tool.name] = uriFromMeta;
      }
    }
    return result;
  } catch (error) {
    logger.debug({ error, agentId }, "Failed to fetch tool UI resource URIs");
    return {};
  }
}

/**
 * Fetches the UI resource HTML for a single MCP App tool on demand.
 *
 * Called when `tool-input-start` fires for a tool that has a UI resource URI.
 *
 * @returns ToolUiResourceData if the resource was fetched successfully, null otherwise
 */
export async function fetchToolUiResource({
  agentId,
  userId,
  organizationId,
  conversationId,
  toolName,
  uri,
}: {
  agentId: string;
  userId: string;
  organizationId: string;
  conversationId?: string;
  toolName: string;
  uri: string;
}): Promise<ToolUiResourceData | null> {
  const cacheKey = `${agentId}:${userId}:${uri}`;
  const cached = uiResourceCache.get(cacheKey);
  if (cached !== undefined) {
    logger.debug({ uri, agentId, toolName }, "UI resource cache hit");
    return cached;
  }

  const client = await getChatMcpClient(
    agentId,
    userId,
    organizationId,
    conversationId,
  );
  if (!client) return null;

  try {
    const resourceResult = await client.readResource({ uri });
    const content = resourceResult.contents?.[0];
    if (!content) return null;

    const html =
      "blob" in content && content.blob
        ? Buffer.from(content.blob, "base64").toString("utf-8")
        : (content as { text?: string }).text;

    if (!html) return null;

    type ContentUiMeta = {
      csp?: McpUiResourceCsp;
      permissions?: McpUiResourcePermissions;
      domain?: string;
    };
    const uiMeta = (content as { _meta?: { ui?: ContentUiMeta } })._meta?.ui;

    if (uiMeta?.domain && !config.mcpSandbox.domain) {
      logger.warn(
        { toolName, uri, domain: uiMeta.domain },
        "MCP server requested stable origin via _meta.ui.domain but sandbox uses opaque origin. " +
          "OAuth callbacks and origin-restricted APIs will not work for this app. " +
          "Set ARCHESTRA_MCP_SANDBOX_DOMAIN to enable per-server origins.",
      );
    }

    const result: ToolUiResourceData = {
      html,
      csp: uiMeta?.csp,
      permissions: uiMeta?.permissions,
    };
    uiResourceCache.set(cacheKey, result);
    return result;
  } catch (error) {
    logger.debug(
      { error, toolName, uri, agentId },
      "Failed to fetch UI resource HTML",
    );
    return null;
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
  conversationId?: string;
  mcpGwToken: {
    tokenId: string;
    teamId: string | null;
    isOrganizationToken: boolean;
  } | null;
  globalToolPolicy: GlobalToolPolicy;
  considerContextUntrusted: boolean;
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
 * @returns The tool result as a string and metadata for the UI renderer
 * @throws Error if tool execution fails
 */
async function executeMcpTool(ctx: ToolExecutionContext): Promise<{
  content: string;
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  rawContent?: ContentBlock[];
  unsafeContextBoundary?: UnsafeContextBoundary;
}> {
  const {
    toolName,
    toolArguments,
    agentId,
    agentName,
    userId,
    organizationId,
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
      { userId, organizationId },
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
      agentId,
      agentName,
      startTime,
      isError: result.isError ?? false,
    });
  } catch (error) {
    reportToolMetrics({
      toolName,
      agentId,
      agentName,
      startTime,
      isError: true,
    });
    throw error;
  }
  throwIfAborted(abortSignal);

  // The MCP path always returns ContentBlock[] in content — narrow from unknown.
  const mcpContent = result.content as ContentBlock[];

  // Check if MCP tool returned an error
  // Return error text as tool result instead of throwing so the AI SDK includes
  // it in the conversation as a tool-result message. This allows the frontend to
  // parse structured errors (e.g. auth-required with action URL) and render
  // actionable UI instead of showing a generic stream error.
  if (result.isError) {
    const extractedError = mcpContent
      ?.map((item) => (item.type === "text" ? item.text : JSON.stringify(item)))
      .join("\n");
    return {
      content: extractedError || result.error || "Tool execution failed",
      ...(await buildUnsafeContextBoundaryResult({
        resultMeta: result._meta,
        toolCallId: toolCall.id,
        toolName,
        toolOutput: extractedError || result.error || "Tool execution failed",
        agentId,
        globalToolPolicy: ctx.globalToolPolicy,
        considerContextUntrusted: ctx.considerContextUntrusted,
      })),
      structuredContent: result.structuredContent,
      rawContent: Array.isArray(result.content)
        ? (result.content as ContentBlock[])
        : undefined,
    };
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
        userContext: { userId, organizationId },
        toolResultContent: mcpContent,
      });
    }
  }

  // Convert MCP content to string for AI SDK
  // Handles standard content types: text, image, resource (embedded UI resources)
  const hasRenderableUI = mcpContent.some(
    (item) =>
      item.type === "resource" &&
      RENDERABLE_UI_MIME_TYPES.includes(item.resource.mimeType ?? ""),
  );

  let textContent: string;
  if (hasRenderableUI) {
    // When a UI is rendered, give the LLM almost nothing to work with.
    // No data, no descriptions - just a terse confirmation. This prevents
    // verbose LLM responses that describe or explain the already-visible UI.
    textContent = "OK";
  } else {
    textContent = mcpContent
      .map((item) => {
        if (item.type === "text") {
          return item.text;
        }
        if (item.type === "resource") {
          if ("text" in item.resource) return item.resource.text;
          return `[Resource: ${item.resource.uri}]`;
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }

  // The _meta block from tool definitions, containing the ui sub-object (SEP-1865).
  type ToolDefinitionMeta = { ui?: McpUiToolMeta; [key: string]: unknown };

  // Fetch tool definition to get _meta.ui.resourceUri for MCP Apps
  // Per SEP-1865, tool definitions declare _meta.ui.resourceUri to link tools to their UI
  // The tools table stores: meta = { _meta: { ui: { resourceUri: "..." } }, annotations: {...} }
  // Scoped to agent to prevent cross-org metadata leak (findByName is unscoped).
  let toolDefinitionMeta: ToolDefinitionMeta | undefined;
  try {
    const toolDef = await ToolModel.findByNameForAgent(toolName, agentId);
    if (toolDef?.meta) {
      // Extract _meta from the stored structure: { _meta: {...}, annotations: {...} }
      toolDefinitionMeta = (toolDef.meta as { _meta?: ToolDefinitionMeta })
        ?._meta;
    }
  } catch (error) {
    logger.debug(
      { error, toolName, agentId },
      "Failed to fetch tool definition meta",
    );
  }

  // Check for embedded resources (type: "resource" content items with UI resources)
  // MCP servers can return UI resources inline in tool results as an alternative to
  // declaring _meta.ui.resourceUri in tool definitions. Both patterns are standard MCP.
  const resourceItems = mcpContent.filter(
    (item): item is EmbeddedResource => item.type === "resource",
  );
  // Prefer renderable resources (text/html) over data resources (application/json, etc.)
  const embeddedResourceItem =
    resourceItems.find((item) =>
      RENDERABLE_UI_MIME_TYPES.includes(item.resource.mimeType ?? ""),
    ) ?? resourceItems[0];

  if (embeddedResourceItem && !toolDefinitionMeta?.ui?.resourceUri) {
    // Synthesize _meta.ui from the embedded resource so frontend can detect and render it
    toolDefinitionMeta = {
      ...toolDefinitionMeta,
      ui: {
        ...toolDefinitionMeta?.ui,
        resourceUri: embeddedResourceItem.resource.uri,
      },
    };
  }

  // Merge tool definition meta with result meta (tool definition takes precedence for ui.resourceUri)
  const mergedMeta = {
    ...result._meta,
    ...toolDefinitionMeta,
  };

  if (toolDefinitionMeta || result.structuredContent) {
    logger.debug(
      {
        toolName,
        hasToolDefinitionMeta: !!toolDefinitionMeta,
        hasStructuredContent: !!result.structuredContent,
        uiResourceUri: toolDefinitionMeta?.ui?.resourceUri,
      },
      "MCP Apps: Tool result with metadata for AppRenderer",
    );
  }

  return {
    content: textContent,
    ...(await buildUnsafeContextBoundaryResult({
      resultMeta: Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined,
      toolCallId: toolCall.id,
      toolName,
      toolOutput: result.structuredContent ?? textContent,
      agentId,
      globalToolPolicy: ctx.globalToolPolicy,
      considerContextUntrusted: ctx.considerContextUntrusted,
    })),
    structuredContent: result.structuredContent,
    rawContent: mcpContent,
  };
}

async function buildUnsafeContextBoundaryResult(params: {
  resultMeta?: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
  toolOutput: unknown;
  agentId: string;
  globalToolPolicy: GlobalToolPolicy;
  considerContextUntrusted: boolean;
}): Promise<{
  _meta?: Record<string, unknown>;
  unsafeContextBoundary?: UnsafeContextBoundary;
}> {
  const unsafeContextBoundary =
    await evaluateUnsafeContextBoundaryForToolResult(params);
  const mergedMeta = unsafeContextBoundary
    ? {
        ...params.resultMeta,
        unsafeContextBoundary,
      }
    : params.resultMeta;

  return {
    ...(mergedMeta && Object.keys(mergedMeta).length > 0
      ? { _meta: mergedMeta }
      : {}),
    ...(unsafeContextBoundary ? { unsafeContextBoundary } : {}),
  };
}

async function evaluateUnsafeContextBoundaryForToolResult(params: {
  toolCallId: string;
  toolName: string;
  toolOutput: unknown;
  agentId: string;
  globalToolPolicy: GlobalToolPolicy;
  considerContextUntrusted: boolean;
}): Promise<UnsafeContextBoundary | undefined> {
  if (params.considerContextUntrusted) {
    return undefined;
  }

  const teamIds = await AgentTeamModel.getTeamsForAgent(params.agentId);
  const evaluation = await TrustedDataPolicyModel.evaluateBulk(
    params.agentId,
    [
      {
        toolName: params.toolName,
        toolOutput: params.toolOutput,
      },
    ],
    params.globalToolPolicy,
    {
      teamIds,
      externalAgentId: getChatExternalAgentId(),
    },
  );

  const toolResultEvaluation = evaluation.get("0");
  if (!toolResultEvaluation) {
    return {
      kind: "tool_result",
      reason: UNSAFE_CONTEXT_BOUNDARY_REASON.toolResultMarkedUntrusted,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
    };
  }

  if (toolResultEvaluation.isBlocked) {
    return {
      kind: "tool_result",
      reason: UNSAFE_CONTEXT_BOUNDARY_REASON.toolResultBlocked,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
    };
  }

  if (!toolResultEvaluation.isTrusted) {
    return {
      kind: "tool_result",
      reason: UNSAFE_CONTEXT_BOUNDARY_REASON.toolResultMarkedUntrusted,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
    };
  }

  return undefined;
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
  // Archestra built-in tools always bypass custom selection (they are auto-injected
  // and hidden from the UI, so users cannot select them)
  const filteredTools: Record<string, Tool> = {};
  const excludedTools: string[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (
      archestraMcpBranding.isToolName(name) ||
      enabledToolNames.includes(name)
    ) {
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

function buildTokenAuthContext({
  mcpGwToken,
  organizationId,
  userId,
}: {
  mcpGwToken: Awaited<ReturnType<typeof selectMCPGatewayToken>>;
  organizationId: string;
  userId: string;
}): TokenAuthContext | undefined {
  if (!mcpGwToken) {
    return undefined;
  }

  return {
    tokenId: mcpGwToken.tokenId,
    teamId: mcpGwToken.teamId,
    isOrganizationToken: mcpGwToken.isOrganizationToken,
    organizationId,
    isUserToken: mcpGwToken.isUserToken,
    userId: mcpGwToken.isUserToken ? userId : undefined,
  };
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

async function throwIfApprovalRequired(
  toolName: string,
  args: unknown,
  globalToolPolicy: GlobalToolPolicy,
): Promise<void> {
  const requiresApproval =
    await ToolInvocationPolicyModel.checkApprovalRequired(
      toolName,
      isRecord(args) ? args : {},
      {
        teamIds: [],
        externalAgentId: getChatExternalAgentId(),
      },
      globalToolPolicy,
    );
  if (requiresApproval) {
    throw new Error(TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON);
  }
}

function reportToolMetrics(params: {
  toolName: string;
  agentId: string;
  agentName: string;
  agentType?: AgentType | null;
  startTime: number;
  isError: boolean;
}): void {
  const { serverName } = parseFullToolName(params.toolName);
  metrics.mcp.reportMcpToolCall({
    agentId: params.agentId,
    agentName: params.agentName,
    agentType: params.agentType ?? null,
    mcpServerName: serverName ?? "unknown",
    toolName: params.toolName,
    durationSeconds: (Date.now() - params.startTime) / 1000,
    isError: params.isError,
  });
}
