import {
  ApiError,
  isAgentTool,
  isBrowserMcpTool,
  MCP_APPS_CLIENT_EXTENSION_CAPABILITIES,
  TimeInMs,
} from "@archestra/shared";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
  McpUiToolMeta,
} from "@modelcontextprotocol/ext-apps";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "ai";
import { archestraMcpBranding, getAgentTools } from "@/archestra-mcp-server";
import { CacheKey, LRUCacheManager } from "@/cache-manager";
import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import {
  buildAgentDelegationTool,
  buildMcpGatewayTool,
  type ChatToolContext,
  type McpGatewayToken,
} from "@/clients/chat-tool-builder";
import { ToolCallRepeatTracker } from "@/clients/tool-call-repeat-tracker";
import config from "@/config";
import type { CollectedHookRun } from "@/hooks/hook-run-parts";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  OrganizationModel,
  TeamModel,
  TeamTokenModel,
  ToolModel,
  UserTokenModel,
} from "@/models";
import { resolveSessionExternalIdpToken } from "@/services/identity-providers/session-token";
import type { DiscoveredToolPolicy, GlobalToolPolicy } from "@/types";
import type { ClientCapabilitiesWithExtensions } from "@/types/mcp-capabilities";
import { buildMcpClientInfo } from "@/utils/mcp-client-info";

/**
 * MCP Gateway base URL (internal)
 * Chat connects to the MCP Gateway endpoint with profile ID in path.
 * Derives from the configured API port to work in multi-pod deployments.
 */
const MCP_GATEWAY_BASE_URL = `http://localhost:${config.api.port}/v1/mcp`;

/**
 * Raised when the agent's MCP tool set could not be fetched (no gateway token,
 * the gateway connection failed, or `tools/list` threw) — as distinct from an
 * agent that genuinely exposes no model-visible tools. Callers must not stream
 * the model with an empty tool set on failure: the agent's system prompt still
 * demands tool calls, so the model hallucinates them as text. Surfaces as a 503
 * through the Fastify error handler; `internalCode` discriminates it from other
 * 503s for callers and tests.
 *
 * @public — thrown from getChatMcpTools, asserted in its tests
 */
export class McpToolsUnavailableError extends ApiError {
  constructor(reason: string) {
    super(503, `MCP tools unavailable: ${reason}`, "mcp_tools_unavailable");
  }
}

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
    clientLastValidatedAt.delete(key);
  },
});

/**
 * Tool cache TTL - 30 seconds to avoid hammering MCP Gateway
 */
const TOOL_CACHE_TTL_MS = 30 * TimeInMs.Second;
const CLIENT_PING_TIMEOUT_MS = 5 * TimeInMs.Second;
const CLIENT_PING_VALIDATION_INTERVAL_MS = 30 * TimeInMs.Second;
const CLIENT_CONNECT_TIMEOUT_MS = 15 * TimeInMs.Second;

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
/**
 * A cached tool set plus the `ChatToolContext` its wrappers close over. The
 * context is retained so the per-run `repeatTracker` can be reset on each cache
 * hit (the cache is keyed per agent/user/scope and outlives a single run).
 */
interface CachedToolSet {
  tools: Record<string, Tool>;
  context: ChatToolContext;
}

const toolCache = new LRUCacheManager<CachedToolSet>({
  maxSize: MAX_TOOL_CACHE_SIZE,
  defaultTtl: TOOL_CACHE_TTL_MS,
});

const clientLastValidatedAt = new Map<string, number>();

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
 * Generate cache key from agentId, userId, and optional isolation key
 * (conversation id in UI chat, generated execution key in headless runs).
 * When provided, each conversation/execution gets its own MCP client and
 * therefore its own browser instance for proper isolation.
 */
function getCacheKey(
  agentId: string,
  userId: string,
  isolationKey?: string,
): string {
  if (isolationKey) {
    return `${agentId}:${userId}:${isolationKey}`;
  }
  return `${agentId}:${userId}`;
}

/**
 * Generate the full cache key for tool cache
 * Includes the isolation key because browser tools need correct tab selection
 */
function getToolCacheKey(
  agentId: string,
  userId: string,
  isolationKey?: string,
): `${typeof CacheKey.ChatMcpTools}-${string}` {
  const baseKey = getCacheKey(agentId, userId);
  const parts = [baseKey];
  if (isolationKey) parts.push(isolationKey);
  return `${CacheKey.ChatMcpTools}-${parts.join(":")}`;
}

/** @public — exported for testability */
export const __test = {
  setCachedClient(cacheKey: string, client: Client, ttl?: number) {
    clientCache.set(cacheKey, client, ttl);
    clientLastValidatedAt.set(cacheKey, 0);
  },
  setCachedClientLastValidatedAt(cacheKey: string, timestamp: number) {
    clientLastValidatedAt.set(cacheKey, timestamp);
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
  filterToolsByEnabledIds,
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
): Promise<McpGatewayToken | null> {
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
      clientLastValidatedAt.delete(key);
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
 * Close and remove cached MCP client for a specific agent/user/scope.
 * Should be called when browser stream unsubscribes to free resources.
 *
 * @param agentId - The agent (profile) ID
 * @param userId - The user ID
 * @param isolationKey - Conversation id (UI chat) or execution key (headless)
 */
export function closeChatMcpClient(
  agentId: string,
  userId: string,
  isolationKey: string,
): void {
  const cacheKey = getCacheKey(agentId, userId, isolationKey);
  const client = clientCache.get(cacheKey);
  if (client) {
    try {
      client.close();
      logger.info(
        { agentId, userId, isolationKey, cacheKey },
        "Closed MCP client connection for conversation",
      );
    } catch (error) {
      logger.warn(
        { agentId, userId, isolationKey, cacheKey, error },
        "Error closing MCP client connection (non-fatal)",
      );
    }
    clientCache.delete(cacheKey);
    clientLastValidatedAt.delete(cacheKey);
  }

  // Also clear tool cache for this conversation/execution
  const toolCacheKey = getToolCacheKey(agentId, userId, isolationKey);
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
 * @param isolationKey - Optional conversation id or execution key for per-conversation/per-execution browser isolation
 * @returns MCP Client connected to the gateway, or null if connection fails
 * @public — exported for testability
 */
export async function getChatMcpClient(
  agentId: string,
  userId: string,
  organizationId: string,
  isolationKey?: string,
  /** Pre-resolved token to avoid a redundant selectMCPGatewayToken call */
  preResolvedTokenValue?: string,
): Promise<Client | null> {
  const cacheKey = getCacheKey(agentId, userId, isolationKey);

  // Check cache first
  const cachedClient = clientCache.get(cacheKey);
  if (cachedClient) {
    // Health check idle clients to verify the connection is still alive.
    // Recently-used clients skip the ping and recover on actual call failure.
    try {
      if (shouldValidateCachedClient(cacheKey)) {
        await pingClientWithTimeout(cachedClient);
        clientLastValidatedAt.set(cacheKey, Date.now());
      }
      logger.info(
        { agentId, userId },
        "Returning cached MCP client for agent/user",
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
      clientLastValidatedAt.delete(cacheKey);
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
    // Bound the connect: a loopback gateway that stalls (e.g. during a deploy)
    // would otherwise hang this await indefinitely and wedge the chat turn. A
    // timeout surfaces as a connect failure → token fallback → typed throw.
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(() => {
            reject(
              new Error(
                `MCP Gateway connect timeout after ${CLIENT_CONNECT_TIMEOUT_MS}ms`,
              ),
            );
          }, CLIENT_CONNECT_TIMEOUT_MS);
          connectTimer.unref?.();
        }),
      ]);
    } catch (connectError) {
      // The race only stops awaiting; close the half-open client so a connect
      // that completes after the timeout can't leak its transport and socket.
      try {
        await client.close();
      } catch (closeError) {
        logger.warn(
          { agentId, userId, closeError },
          "Error closing timed-out MCP client (non-fatal)",
        );
      }
      throw connectError;
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
    }
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
    clientLastValidatedAt.set(cacheKey, Date.now());

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
        clientLastValidatedAt.set(cacheKey, Date.now());

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

function shouldValidateCachedClient(cacheKey: string): boolean {
  const lastValidatedAt = clientLastValidatedAt.get(cacheKey) ?? 0;
  return Date.now() - lastValidatedAt >= CLIENT_PING_VALIDATION_INTERVAL_MS;
}

/**
 * Get all MCP tools for the specified agent and user in AI SDK Tool format
 * (wrapping and schema normalization live in chat-tool-builder)
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
  isolationKey,
  sessionId,
  delegationChain,
  abortSignal,
  elicitation,
  user,
  blockOnApprovalRequired,
  scheduleTriggerRunId,
  hookRunCollector,
  repeatTracker,
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
  /**
   * Id of a persisted `conversations` row — tools may persist it as a foreign
   * key. Absent in headless executions (A2A, ChatOps, schedules, email).
   */
  conversationId?: string;
  /**
   * Opaque key scoping per-execution state: browser tabs, MCP client/tool
   * caches, headless sandboxes. Defaults to `conversationId`. Headless
   * executions pass their generated execution key here instead of faking a
   * conversation id.
   */
  isolationKey?: string;
  /** Session ID for grouping related LLM requests in logs */
  sessionId?: string;
  /** Delegation chain of agent IDs for tracking delegated agent calls */
  delegationChain?: string;
  /** Optional cancellation signal from parent stream execution */
  abortSignal?: AbortSignal;
  /** Optional MCP elicitation bridge for interactive chat clients */
  elicitation?: ChatMcpElicitationBridge;
  /** User identity for OTEL span attributes */
  user?: { id: string; email?: string; name?: string };
  /** Block tool execution when policy is require_approval (for A2A/autonomous contexts where no one can approve) */
  blockOnApprovalRequired?: boolean;
  /** Schedule trigger run ID — enables artifact_write to target the run */
  scheduleTriggerRunId?: string;
  /** Per-turn sink for inline `data-hook-run` entries (chat path only). */
  hookRunCollector?: CollectedHookRun[];
  /**
   * Per-run repeated-tool-call tracker. Run entrypoints that own a `stopWhen`
   * pass their own instance so the breaker records into the same tracker the
   * run's `repeatCeilingStopCondition` reads (single source of truth). Callers
   * with no stream (e.g. the tool-listing endpoint) and tests omit it and get a
   * fresh internal tracker.
   */
  repeatTracker?: ToolCallRepeatTracker;
}): Promise<Record<string, Tool>> {
  const scopeKey = isolationKey ?? conversationId;
  const toolCacheKey = getToolCacheKey(agentId, userId, scopeKey);
  const shouldUseToolCache = !abortSignal;

  // Check in-memory tool cache first (cannot use distributed cacheManager - Tool objects have execute functions)
  // LRU eviction and TTL are handled automatically by LRUCacheManager
  const cached = shouldUseToolCache ? toolCache.get(toolCacheKey) : null;
  if (cached) {
    // Reset the per-run repeat tracker: this entry is keyed per agent/user/scope
    // and lives for the cache TTL, so without this a later run on the same scope
    // would inherit the previous run's repeat counts. getChatMcpTools is called
    // once per run, and every wrapper reads the tracker through this context.
    // Best-effort under concurrency: two overlapping no-abortSignal runs on the
    // same scope share this context, so a reset can clear the other's in-flight
    // streak — fail-open (the breaker under-fires, never falsely fires). When the
    // caller owns the tracker, bind that instance so its stop condition reads the
    // same streak the breaker records into.
    cached.context.repeatTracker = repeatTracker ?? new ToolCallRepeatTracker();
    logger.info(
      {
        agentId,
        userId,
        toolCount: Object.keys(cached.tools).length,
      },
      "Returning cached MCP tools for chat",
    );
    // Apply filtering if enabledToolIds provided and non-empty
    return await filterToolsByEnabledIds(cached.tools, enabledToolIds);
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
      "No valid team token available for user - cannot fetch tools",
    );
    throw new McpToolsUnavailableError("no gateway token for user");
  }

  // Still use MCP client for listing tools (via MCP Gateway)
  // Pass the scope key for per-conversation/per-execution browser isolation.
  // Forward the already-resolved token to avoid a duplicate selectMCPGatewayToken call.
  const client = await getChatMcpClient(
    agentId,
    userId,
    organizationId,
    scopeKey,
    mcpGwToken.tokenValue,
  );

  if (!client) {
    logger.warn(
      { agentId, userId },
      "No MCP client available - failing the turn instead of streaming with empty tools",
    );
    throw new McpToolsUnavailableError("could not connect to MCP Gateway");
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

    // rawToolCount vs toolCount makes a successful-but-model-empty fetch
    // diagnosable: when the gateway returns tools but every one is filtered out
    // (all app-only, or stripped as agent tools), the model still sees nothing.
    // That is a legitimate state (we don't throw), but the gap is worth logging.
    logger.info(
      {
        agentId,
        userId,
        rawToolCount: mcpTools.length,
        toolCount: filteredMcpTools.length,
        toolNames: filteredMcpTools.map((t) => t.name),
      },
      "Fetched tools from MCP Gateway for agent/user",
    );

    // Fetch globalToolPolicy for approval checks (needed for both chat and
    // autonomous contexts) and the agent's + user's teams (for trace span
    // attributes).
    const [org, agent, teams, userTeams] = await Promise.all([
      OrganizationModel.getById(organizationId),
      AgentModel.findById(agentId),
      AgentTeamModel.getTeamLabelInfoForAgent(agentId),
      TeamModel.getTeamLabelInfoForUser({ userId, organizationId }),
    ]);
    const globalToolPolicy: GlobalToolPolicy =
      org?.globalToolPolicy ?? "permissive";
    const discoveredToolPolicy: DiscoveredToolPolicy =
      org?.discoveredToolPolicy ?? "relaxed";
    const considerContextUntrusted = agent?.considerContextUntrusted ?? false;

    // Convert MCP tools to AI SDK Tool format
    const toolContext: ChatToolContext = {
      agentId,
      agentName,
      userId,
      organizationId,
      conversationId,
      scopeKey,
      chatOpsBindingId,
      chatOpsThreadId,
      sessionId,
      delegationChain,
      scheduleTriggerRunId,
      abortSignal,
      elicitation,
      user,
      blockOnApprovalRequired,
      hookRunCollector,
      mcpGwToken,
      globalToolPolicy,
      discoveredToolPolicy,
      considerContextUntrusted,
      teams,
      userTeams,
      // One tracker per run: the caller's instance when it owns a stop policy,
      // otherwise a fresh one. On a cache hit it is rebound (see above) so
      // repeat counts never carry across runs.
      repeatTracker: repeatTracker ?? new ToolCallRepeatTracker(),
    };
    const aiTools: Record<string, Tool> = {};

    for (const mcpTool of filteredMcpTools) {
      try {
        aiTools[mcpTool.name] = buildMcpGatewayTool({
          mcpTool,
          ctx: toolContext,
        });
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

        // Convert agent tools to AI SDK Tool format
        for (const agentTool of agentToolsList) {
          aiTools[agentTool.name] = buildAgentDelegationTool({
            agentTool,
            ctx: toolContext,
          });
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
      toolCache.set(toolCacheKey, { tools: aiTools, context: toolContext });
    }

    // Apply filtering if enabledToolIds provided and non-empty
    return await filterToolsByEnabledIds(aiTools, enabledToolIds);
  } catch (error) {
    logger.error(
      { agentId, userId, error },
      "Failed to fetch tools from MCP Gateway",
    );
    // Evict the client so a transient tools/list failure self-heals on the next
    // turn instead of reusing the same failing session until the idle TTL. The
    // detail stays in the log above; the thrown message is kept generic so raw
    // gateway error text never reaches the API client.
    const cacheKey = getCacheKey(agentId, userId, scopeKey);
    try {
      await client.close();
    } catch (closeError) {
      logger.warn(
        { agentId, userId, closeError },
        "Error closing MCP client after tool fetch failure (non-fatal)",
      );
    }
    clientCache.delete(cacheKey);
    clientLastValidatedAt.delete(cacheKey);
    throw new McpToolsUnavailableError("tool listing failed");
  }
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
 * Filter tools by enabled tool IDs
 * If enabledToolIds is undefined, returns all tools (no custom selection = all enabled)
 * If enabledToolIds is empty array, returns only archestra built-in tools (a custom
 *   selection of zero user-selectable tools; built-ins always bypass the selection)
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

  // Fetch tool names for the enabled IDs (empty array -> empty set, leaving only
  // the built-in bypass below to populate the result)
  const enabledToolNames = await ToolModel.getNamesByIds(enabledToolIds);

  // Filter tools to only include enabled ones.
  // Archestra built-in tools always bypass custom selection (they are auto-injected
  // and hidden from the UI, so users cannot select or deselect them). This is what
  // keeps search_tools/run_tool available to search_and_run_only agents even when a
  // conversation's custom selection enables zero user-selectable tools.
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
