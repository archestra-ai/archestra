import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_CATALOG_INSTALL_PATH,
  MCP_CATALOG_INSTALL_QUERY_PARAM,
} from "@shared";
import config from "@/config";
import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import {
  InternalMcpCatalogModel,
  McpHttpSessionModel,
  McpServerModel,
  McpToolCallModel,
  TeamModel,
  ToolModel,
} from "@/models";
import { refreshOAuthToken } from "@/routes/oauth";
import { secretManager } from "@/secrets-manager";
import { applyResponseModifierTemplate } from "@/templating";
import type {
  CommonMcpToolDefinition,
  CommonToolCall,
  CommonToolResult,
  InternalMcpCatalog,
  MCPGatewayAuthMethod,
} from "@/types";
import { deriveAuthMethod } from "@/utils/auth-method";
import { previewToolResultContent } from "@/utils/tool-result-preview";
import { K8sAttachTransport } from "./k8s-attach-transport";

/**
 * Thrown when a stored HTTP session ID is no longer valid (e.g. pod restarted).
 * Caught by executeToolCall to trigger a transparent retry with a fresh session.
 */
class StaleSessionError extends Error {
  constructor(connectionKey: string) {
    super(`Stale MCP HTTP session for connection ${connectionKey}`);
    this.name = "StaleSessionError";
  }
}

/**
 * Type for MCP tool with server metadata returned from database
 */
type McpToolWithServerMetadata = {
  toolName: string;
  responseModifierTemplate: string | null;
  mcpServerSecretId: string | null;
  mcpServerName: string | null;
  mcpServerCatalogId: string | null;
  mcpServerId: string | null;
  credentialSourceMcpServerId: string | null;
  executionSourceMcpServerId: string | null;
  useDynamicTeamCredential: boolean;
  catalogId: string | null;
  catalogName: string | null;
};

/**
 * Token authentication context for dynamic credential resolution
 */
export type TokenAuthContext = {
  tokenId: string;
  teamId: string | null;
  isOrganizationToken: boolean;
  /** Organization ID the token belongs to (required for agent delegation tools) */
  organizationId?: string;
  /** True if this is a personal user token */
  isUserToken?: boolean;
  /** Optional user ID for user-owned server priority (set when called from chat or from user token) */
  userId?: string;
  /** True if authenticated via external IdP JWKS */
  isExternalIdp?: boolean;
  /** Raw JWT token for propagation to underlying MCP servers (set when isExternalIdp is true) */
  rawToken?: string;
};

/**
 * Simple async queue to serialize operations per connection
 * Prevents concurrent MCP calls to the same server (important for stdio transport)
 */
type QueueState = {
  activeCount: number;
  queue: Array<() => void>;
};

class ConnectionLimiter {
  private states = new Map<string, QueueState>();

  /**
   * Execute a function with a per-connection concurrency limit.
   */
  runWithLimit<T>(
    connectionKey: string,
    limit: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (limit <= 0) {
      return fn();
    }

    const state = this.states.get(connectionKey) ?? {
      activeCount: 0,
      queue: [],
    };
    this.states.set(connectionKey, state);

    return new Promise<T>((resolve, reject) => {
      const execute = () => {
        state.activeCount += 1;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            state.activeCount -= 1;
            const next = state.queue.shift();
            if (next) {
              next();
              return;
            }
            if (state.activeCount === 0) {
              this.states.delete(connectionKey);
            }
          });
      };

      if (state.activeCount < limit) {
        execute();
        return;
      }

      state.queue.push(execute);
    });
  }
}

type TransportKind = "stdio" | "http";

const HTTP_CONCURRENCY_LIMIT = 4;

class McpClient {
  private clients = new Map<string, Client>();
  private activeConnections = new Map<string, Client>();
  private connectionLimiter = new ConnectionLimiter();
  // Cache of actual tool names per connection key: lowercased name -> original cased name
  private toolNameCache = new Map<string, Map<string, string>>();
  // Per-connectionKey lock to prevent thundering-herd when multiple concurrent
  // calls (e.g. browser stream ticks) detect a stale session simultaneously.
  // Only the first caller performs cleanup + retry; others wait and reuse.
  private sessionRecoveryLocks = new Map<string, Promise<void>>();
  // Session affinity metadata discovered during transport creation.
  // Used when persisting fresh session IDs after connect().
  private pendingHttpSessionMetadata = new Map<
    string,
    { sessionEndpointUrl: string | null; sessionEndpointPodName: string | null }
  >();

  /**
   * Close a cached session for a specific (catalogId, targetMcpServerId, agentId, conversationId).
   * Should be called when a subagent finishes to free the browser context.
   */
  closeSession(
    catalogId: string,
    targetMcpServerId: string,
    agentId: string,
    conversationId: string,
  ): void {
    const connectionKey = `${catalogId}:${targetMcpServerId}:${agentId}:${conversationId}`;
    const client = this.activeConnections.get(connectionKey);
    if (client) {
      try {
        client.close();
      } catch (error) {
        logger.warn(
          { connectionKey, error },
          "Error closing MCP session (non-fatal)",
        );
      }
      this.activeConnections.delete(connectionKey);
      this.toolNameCache.delete(connectionKey);
      this.pendingHttpSessionMetadata.delete(connectionKey);
      logger.info({ connectionKey }, "Closed cached MCP session");
    }

    // Clean up the stored session ID so other pods don't try to reuse it
    McpHttpSessionModel.deleteByConnectionKey(connectionKey).catch((err) =>
      logger.warn(
        { connectionKey, err },
        "Failed to delete stored MCP HTTP session (non-fatal)",
      ),
    );
  }

  /**
   * Execute a single tool call against its assigned MCP server
   */
  async executeToolCall(
    toolCall: CommonToolCall,
    agentId: string,
    tokenAuth?: TokenAuthContext,
    options?: { conversationId?: string },
  ): Promise<CommonToolResult> {
    // Derive auth info for logging
    const authInfo = tokenAuth
      ? {
          userId: tokenAuth.userId,
          authMethod: deriveAuthMethod(tokenAuth),
        }
      : undefined;

    // Validate and get tool metadata
    const validationResult = await this.validateAndGetTool(toolCall, agentId);
    if ("error" in validationResult) {
      return validationResult.error;
    }
    const { tool, catalogItem } = validationResult;

    const targetMcpServerIdResult =
      await this.determineTargetMcpServerIdForCatalogItem({
        tool,
        toolCall,
        agentId,
        tokenAuth,
        catalogItem,
      });
    if ("error" in targetMcpServerIdResult) {
      return targetMcpServerIdResult.error;
    }
    const { targetMcpServerId } = targetMcpServerIdResult;
    const secretsResult = await this.getSecretsForMcpServer({
      targetMcpServerId: targetMcpServerId,
      toolCall,
      agentId,
    });
    if ("error" in secretsResult) {
      return secretsResult.error;
    }
    const { secrets, secretId } = secretsResult;

    // Build connection cache key using the resolved target server ID.
    // When conversationId is provided, each (agent, conversation) gets its own connection
    // to enable per-session browser context isolation with streamable-http transport.
    // When authenticated via external IdP, each user gets their own connection
    // since the JWT is propagated to the underlying MCP server per-user.
    const externalIdpUserId = tokenAuth?.isExternalIdp
      ? tokenAuth.userId
      : undefined;
    let connectionKey = options?.conversationId
      ? `${catalogItem.id}:${targetMcpServerId}:${agentId}:${options.conversationId}`
      : `${catalogItem.id}:${targetMcpServerId}`;
    if (externalIdpUserId) {
      connectionKey = `${connectionKey}:ext:${externalIdpUserId}`;
    }

    const executeToolCall = async (
      getTransport: () => Promise<Transport>,
      currentSecrets: Record<string, unknown>,
      isRetry = false,
    ): Promise<CommonToolResult> => {
      try {
        // Get the appropriate transport
        const transport = await getTransport();

        // Get or create client
        const client = await this.getOrCreateClient(connectionKey, transport);

        // Determine the actual tool name by stripping the server/catalog prefix.
        // We prioritize the `catalogName` prefix, which is standard for local MCP servers.
        // If the tool name doesn't match the catalog prefix, we fall back to the `mcpServerName` (typical for remote servers).
        let targetToolName = this.stripServerPrefix(
          toolCall.name,
          tool.catalogName || "",
        );

        if (targetToolName === toolCall.name && tool.mcpServerName) {
          // No prefix match with catalogName; attempt to strip using mcpServerName instead.
          targetToolName = this.stripServerPrefix(
            toolCall.name,
            tool.mcpServerName,
          );
        }

        // Resolve the actual tool name from the server (preserving original casing).
        // Tool names in the DB are lowercased by slugifyName(), but remote MCP servers
        // may use camelCase or mixed-case names (e.g., "atlassianUserInfo" vs "atlassianuserinfo").
        targetToolName = await this.resolveActualToolName(
          client,
          connectionKey,
          targetToolName,
        );

        const result = await client.callTool({
          name: targetToolName,
          arguments: toolCall.arguments,
        });

        // Apply template and return
        return await this.createSuccessResult(
          toolCall,
          agentId,
          tool.mcpServerName || "unknown",
          result.content,
          !!result.isError,
          tool.responseModifierTemplate,
          authInfo,
        );
      } catch (error) {
        // Handle stale HTTP session.  The MCP SDK skips the `initialize`
        // handshake when `transport.sessionId` is already set (session
        // resumption), so `client.connect()` succeeds without making any
        // HTTP request.  The stale session only surfaces later as a
        // StreamableHTTPError "Session not found" during the first real
        // RPC call (listTools / callTool).  Detect this and retry with a
        // fresh session.
        const isStaleSession =
          error instanceof StaleSessionError ||
          (error instanceof StreamableHTTPError &&
            String(error.message).includes("Session not found"));

        if (isStaleSession && !isRetry) {
          // Check if another concurrent call is already recovering this
          // connection (e.g. multiple browser-stream ticks firing at once).
          // If so, wait for it and reuse the fresh client it creates.
          const existingRecovery = this.sessionRecoveryLocks.get(connectionKey);
          if (existingRecovery) {
            logger.info(
              { connectionKey },
              "Waiting for concurrent session recovery",
            );
            await existingRecovery;
            return executeToolCall(getTransport, currentSecrets, true);
          }

          logger.info(
            { connectionKey },
            "Stale session detected, retrying with fresh session",
          );

          // Acquire recovery lock so concurrent callers wait for us.
          let resolveRecovery!: () => void;
          const recoveryPromise = new Promise<void>((resolve) => {
            resolveRecovery = resolve;
          });
          this.sessionRecoveryLocks.set(connectionKey, recoveryPromise);

          try {
            try {
              await McpHttpSessionModel.deleteStaleSession(connectionKey);
            } catch (err) {
              logger.warn(
                { connectionKey, err },
                "Failed to delete stale MCP HTTP session",
              );
            }
            // Close the stale client so its AbortController is cleaned up
            const staleClient = this.activeConnections.get(connectionKey);
            if (staleClient) {
              try {
                await staleClient.close();
              } catch {
                logger.warn(
                  { connectionKey },
                  "Failed to close stale MCP client",
                );
              }
            }
            this.activeConnections.delete(connectionKey);
            this.toolNameCache.delete(connectionKey);
            this.pendingHttpSessionMetadata.delete(connectionKey);
            return await executeToolCall(getTransport, currentSecrets, true);
          } finally {
            resolveRecovery();
            this.sessionRecoveryLocks.delete(connectionKey);
          }
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // Check if this is an authentication error (401) and we can attempt refresh
        const isAuthError =
          error instanceof UnauthorizedError ||
          (error instanceof StreamableHTTPError && error.code === 401);

        // Only attempt token refresh for OAuth servers with a refresh token
        const isOAuthServer = !!catalogItem.oauthConfig;
        const hasRefreshToken = !!(currentSecrets as { refresh_token?: string })
          .refresh_token;

        // Track and skip recovery if no refresh token available
        if (
          isAuthError &&
          isOAuthServer &&
          targetMcpServerId &&
          !hasRefreshToken
        ) {
          await McpServerModel.update(targetMcpServerId, {
            oauthRefreshError: "no_refresh_token",
            oauthRefreshFailedAt: new Date(),
          });
          logger.warn(
            { toolName: toolCall.name, targetMcpServerId },
            "OAuth authentication error: no refresh token available",
          );
        }

        // Attempt recovery if possible
        const canAttemptRecovery =
          !isRetry &&
          isAuthError &&
          isOAuthServer &&
          secretId &&
          hasRefreshToken;

        if (canAttemptRecovery) {
          const retryToolCallResult = await this.attemptTokenRefreshAndRetry({
            secretId,
            catalogId: catalogItem.id,
            connectionKey,
            toolCall,
            agentId,
            mcpServerName: tool.mcpServerName || "unknown",
            catalogItem,
            targetMcpServerId,
            executeRetry: (getTransport, secrets) =>
              executeToolCall(getTransport, secrets, true),
          });

          if (retryToolCallResult) {
            return retryToolCallResult;
          }
          // If recovery returned null, the error was already recorded in attemptTokenRefreshAndRetry
        }

        return await this.createErrorResult(
          toolCall,
          agentId,
          errorMessage,
          tool.mcpServerName || "unknown",
          authInfo,
        );
      }
    };

    if (!this.shouldLimitConcurrency()) {
      return executeToolCall(
        () =>
          this.getTransport(
            catalogItem,
            targetMcpServerId,
            secrets,
            connectionKey,
            tokenAuth,
          ),
        secrets,
      );
    }

    const transportKind = await this.getTransportKind(
      catalogItem,
      targetMcpServerId,
    );
    const concurrencyLimit = this.getConcurrencyLimit(transportKind);

    return this.connectionLimiter.runWithLimit(
      connectionKey,
      concurrencyLimit,
      () =>
        executeToolCall(
          () =>
            this.getTransportWithKind(
              catalogItem,
              targetMcpServerId,
              secrets,
              transportKind,
              connectionKey,
              tokenAuth,
            ),
          secrets,
        ),
    );
  }

  /**
   * Get or create a client with the given transport
   */
  private async getOrCreateClient(
    connectionKey: string,
    transport: Transport,
  ): Promise<Client> {
    // Check if we already have an active connection
    const existingClient = this.activeConnections.get(connectionKey);
    if (existingClient) {
      // Health check: ping the client to verify connection is still alive
      try {
        await existingClient.ping();
        logger.debug(
          { connectionKey },
          "Client ping successful, reusing cached client",
        );
        return existingClient;
      } catch (error) {
        // Connection is dead, invalidate cache and create fresh client
        logger.warn(
          {
            connectionKey,
            error: error instanceof Error ? error.message : String(error),
          },
          "Client ping failed, creating fresh client",
        );
        this.activeConnections.delete(connectionKey);
        this.toolNameCache.delete(connectionKey);
        this.pendingHttpSessionMetadata.delete(connectionKey);
        // If the transport carries a stored session ID the session is likely
        // stale (e.g. Playwright pod restarted).  Delete it from the DB so
        // the retry path creates a truly fresh connection instead of reading
        // the same stale ID again.
        if (
          transport instanceof StreamableHTTPClientTransport &&
          transport.sessionId
        ) {
          McpHttpSessionModel.deleteStaleSession(connectionKey).catch(() => {});
        }
        // Fall through to create new client
      }
    }

    // Create new client
    logger.info({ connectionKey }, "Creating new MCP client");
    const client = new Client(
      {
        name: "archestra-platform",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    // Track whether we're using a stored session ID (for stale session cleanup)
    const usedStoredSession =
      transport instanceof StreamableHTTPClientTransport &&
      !!transport.sessionId;

    try {
      await client.connect(transport);
    } catch (error) {
      // If we used a stored session ID and connection failed, the session is
      // likely stale (e.g. Playwright pod restarted).  Delete it and throw a
      // StaleSessionError so executeToolCall can retry with a fresh session.
      if (usedStoredSession) {
        try {
          await McpHttpSessionModel.deleteStaleSession(connectionKey);
        } catch (err) {
          logger.warn(
            { connectionKey, err },
            "Failed to delete stale MCP HTTP session",
          );
        }
        throw new StaleSessionError(connectionKey);
      }
      throw error;
    }

    // When resuming a stored session the MCP SDK skips the `initialize`
    // handshake, so `connect()` succeeds without any HTTP request.  Verify
    // the session is actually alive with a ping *before* caching or
    // re-persisting the (potentially stale) session ID.  Without this check
    // concurrent calls would re-persist the stale ID into the DB, undoing
    // another call's cleanup and creating a thundering-herd loop.
    if (usedStoredSession) {
      try {
        await client.ping();
      } catch {
        try {
          await McpHttpSessionModel.deleteStaleSession(connectionKey);
        } catch (err) {
          logger.warn(
            { connectionKey, err },
            "Failed to delete stale MCP HTTP session",
          );
        }
        throw new StaleSessionError(connectionKey);
      }
    }

    // Store the connection for reuse BEFORE persisting session ID.
    // This prevents a race where a second request creates a duplicate connection
    // while the upsert is in flight.
    this.activeConnections.set(connectionKey, client);

    // Persist the MCP session ID so other backend pods can reuse it.
    // With --isolated, each Mcp-Session-Id maps to a separate browser context;
    // storing the ID in the database lets every pod connect to the same context.
    // Only persist *new* session IDs (obtained via fresh init), not stored ones
    // we just verified — those are already in the DB with the correct value.
    if (
      !usedStoredSession &&
      transport instanceof StreamableHTTPClientTransport &&
      transport.sessionId
    ) {
      const pendingMetadata =
        this.pendingHttpSessionMetadata.get(connectionKey);
      try {
        await McpHttpSessionModel.upsert({
          connectionKey,
          sessionId: transport.sessionId,
          sessionEndpointUrl: pendingMetadata?.sessionEndpointUrl,
          sessionEndpointPodName: pendingMetadata?.sessionEndpointPodName,
        });
      } catch (err) {
        logger.warn(
          { connectionKey, err },
          "Failed to persist MCP HTTP session ID (non-fatal)",
        );
      }
    }

    return client;
  }

  /**
   * Validate tool and get metadata
   */
  private async validateAndGetTool(
    toolCall: CommonToolCall,
    agentId: string,
  ): Promise<
    | { tool: McpToolWithServerMetadata; catalogItem: InternalMcpCatalog }
    | { error: CommonToolResult }
  > {
    // Get MCP tool from agent-assigned tools
    const mcpTools = await ToolModel.getMcpToolsAssignedToAgent(
      [toolCall.name],
      agentId,
    );
    const tool = mcpTools[0];

    if (!tool) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          "Tool not found or not assigned to agent",
        ),
      };
    }

    // Validate catalogId
    if (!tool.catalogId) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          "Tool is missing catalogId",
          tool.mcpServerName || "unknown",
        ),
      };
    }

    // Get catalog item
    const catalogItem = await InternalMcpCatalogModel.findById(tool.catalogId);
    if (!catalogItem) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          `No catalog item found for tool catalog ID ${tool.catalogId}`,
          tool.mcpServerName || "unknown",
        ),
      };
    }

    return { tool, catalogItem };
  }

  // Gets secrets of a given MCP server
  private async getSecretsForMcpServer({
    targetMcpServerId,
    toolCall,
    agentId,
  }: {
    targetMcpServerId: string;
    toolCall: CommonToolCall;
    agentId: string;
  }): Promise<
    | { secrets: Record<string, unknown>; secretId?: string }
    | { error: CommonToolResult }
  > {
    const mcpServer = await McpServerModel.findById(targetMcpServerId);
    if (!mcpServer) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          `MCP server not found when getting secrets for MCP server ${targetMcpServerId}`,
          "unknown",
        ),
      };
    }
    if (mcpServer.secretId) {
      const secret = await secretManager().getSecret(mcpServer.secretId);
      if (secret?.secret) {
        logger.info(
          {
            targetMcpServerId,
            secretId: mcpServer.secretId,
          },
          `Found secrets for MCP server ${targetMcpServerId}`,
        );
        return { secrets: secret.secret, secretId: mcpServer.secretId };
      }
    }
    return { secrets: {} };
  }

  // Determines the target MCP server ID for a local catalog item
  // Since there are multiple deployments for a single catalog item that can receive request
  private async determineTargetMcpServerIdForCatalogItem({
    tool,
    tokenAuth,
    toolCall,
    agentId,
    catalogItem,
  }: {
    tool: McpToolWithServerMetadata;
    toolCall: CommonToolCall;
    agentId: string;
    tokenAuth?: TokenAuthContext;
    catalogItem: InternalMcpCatalog;
  }): Promise<{ targetMcpServerId: string } | { error: CommonToolResult }> {
    logger.info(
      {
        toolName: toolCall.name,
        tool: tool,
        tokenAuth: tokenAuth,
      },
      "Determining target MCP server ID for catalog item",
    );
    // Static credential case: use pre-configured execution source
    if (!tool.useDynamicTeamCredential) {
      if (
        catalogItem.serverType === "local" &&
        !tool.executionSourceMcpServerId
      ) {
        return {
          error: await this.createErrorResult(
            toolCall,
            agentId,
            "Execution source is required for local MCP server tools when dynamic team credential is disabled.",
            tool.mcpServerName || "unknown",
          ),
        };
      }
      if (
        catalogItem.serverType === "remote" &&
        !tool.credentialSourceMcpServerId
      ) {
        return {
          error: await this.createErrorResult(
            toolCall,
            agentId,
            "Credential source is required for remote MCP server tools when dynamic team credential is disabled.",
            tool.mcpServerName || "unknown",
          ),
        };
      }
      const result =
        catalogItem.serverType === "local"
          ? tool.executionSourceMcpServerId
          : tool.credentialSourceMcpServerId;
      if (!result) {
        return {
          error: await this.createErrorResult(
            toolCall,
            agentId,
            "Couldn't find execution or credential source for MCP server when dynamic team credential is disabled.",
            tool.mcpServerName || "unknown",
          ),
        };
      }
      logger.info(
        {
          toolName: toolCall.name,
          catalogItem: catalogItem,
          targetMcpServerId: result,
        },
        "Determined target MCP server ID for catalog item",
      );
      return { targetMcpServerId: result };
    }

    // Dynamic credential (resolved on tool call time) case: resolve target MCP server ID based on tokenAuth
    // tokenAuth are profile tokens autocreated when team is assigned to a profile
    if (!tokenAuth) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          "Dynamic team credential is enabled but no token authentication provided. Use a profile token to authenticate.",
          tool.mcpServerName || "unknown",
        ),
      };
    }
    if (!tool.catalogId) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          "Dynamic team credential is enabled but tool has no catalogId.",
          tool.mcpServerName || "unknown",
        ),
      };
    }

    // Get all servers for this catalog
    const allServers = await McpServerModel.findByCatalogId(tool.catalogId);

    // Priority 1: Personal credential owned by current user (no teamId)
    // That happens only from chat UI when we know the user ID
    if (tokenAuth.userId) {
      const userServer = allServers.find(
        (s) => s.ownerId === tokenAuth.userId && !s.teamId,
      );
      if (userServer) {
        logger.info(
          {
            toolName: toolCall.name,
            catalogId: tool.catalogId,
            serverId: userServer.id,
            userId: tokenAuth.userId,
          },
          `Dynamic resolution: using user-owned server of ${userServer.id} for tool ${toolCall.name}`,
        );
        return { targetMcpServerId: userServer.id };
      }
    }

    // Priority 2 & 3: Team token used - batch-load team members once to avoid N+1 queries
    if (tokenAuth.teamId) {
      const teamMembers = await TeamModel.getTeamMembers(tokenAuth.teamId);
      const teamMemberIds = new Set(teamMembers.map((m) => m.userId));

      // Priority 2: Personal credential owned by a team member (no teamId on server)
      for (const server of allServers) {
        if (
          server.ownerId &&
          !server.teamId &&
          teamMemberIds.has(server.ownerId)
        ) {
          logger.info(
            {
              toolName: toolCall.name,
              catalogId: tool.catalogId,
              serverId: server.id,
              ownerId: server.ownerId,
              teamId: tokenAuth.teamId,
            },
            `Dynamic resolution: using server owned by personal credential of ${server.ownerId} of ${server.id} for tool ${toolCall.name}`,
          );
          return { targetMcpServerId: server.id };
        }
      }

      // Priority 3: Any server owned by a team member
      for (const server of allServers) {
        if (server.ownerId && teamMemberIds.has(server.ownerId)) {
          logger.info(
            {
              toolName: toolCall.name,
              catalogId: tool.catalogId,
              serverId: server.id,
              ownerId: server.ownerId,
              teamId: tokenAuth.teamId,
            },
            `Dynamic resolution: using server owned by team member ${server.ownerId} of ${server.id} for tool ${toolCall.name}`,
          );
          return { targetMcpServerId: server.id };
        }
      }
    }

    // Priority 4: Otherwise, if organization-wide token is used, use first available server
    if (tokenAuth.isOrganizationToken && allServers.length > 0) {
      logger.info(
        {
          toolName: toolCall.name,
          catalogId: tool.catalogId,
          serverId: allServers[0].id,
        },
        `Dynamic resolution: using org-wide server of ${allServers[0].id} for tool ${toolCall.name}`,
      );
      return { targetMcpServerId: allServers[0].id };
    }

    // Priority 5: Fallback for external IdP users if earlier team-based resolution didn't match
    if (tokenAuth.isExternalIdp && allServers.length > 0) {
      logger.info(
        {
          toolName: toolCall.name,
          catalogId: tool.catalogId,
          serverId: allServers[0].id,
        },
        `Dynamic resolution: using first available server for external IdP user`,
      );
      return { targetMcpServerId: allServers[0].id };
    }

    // No server found - return an actionable error with install link
    const context = tokenAuth.userId
      ? `user: ${tokenAuth.userId}`
      : tokenAuth.teamId
        ? `team: ${tokenAuth.teamId}`
        : "organization";
    const catalogDisplayName = tool.catalogName || tool.catalogId;
    const installUrl = `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_INSTALL_QUERY_PARAM}=${tool.catalogId}`;
    return {
      error: await this.createErrorResult(
        toolCall,
        agentId,
        `Authentication required for "${catalogDisplayName}".\n\nNo credentials were found for your account (${context}).\nTo set up your credentials, visit: ${installUrl}\n\nOnce you have completed authentication, retry this tool call.`,
        tool.mcpServerName || "unknown",
      ),
    };
  }

  /**
   * Get appropriate transport based on server type and configuration
   */
  private shouldLimitConcurrency(): boolean {
    return config.features.browserStreamingEnabled;
  }

  private getConcurrencyLimit(transportKind: TransportKind): number {
    return transportKind === "stdio" ? 1 : HTTP_CONCURRENCY_LIMIT;
  }

  private async getTransportKind(
    catalogItem: InternalMcpCatalog,
    targetMcpServerId: string,
  ): Promise<TransportKind> {
    if (catalogItem.serverType === "remote") {
      return "http";
    }

    const usesStreamableHttp =
      await McpServerRuntimeManager.usesStreamableHttp(targetMcpServerId);
    return usesStreamableHttp ? "http" : "stdio";
  }

  private async getTransportWithKind(
    catalogItem: InternalMcpCatalog,
    targetMcpServerId: string,
    secrets: Record<string, unknown>,
    transportKind: TransportKind,
    connectionKey?: string,
    tokenAuth?: TokenAuthContext,
  ): Promise<Transport> {
    if (transportKind === "http") {
      if (catalogItem.serverType === "local") {
        const url =
          await McpServerRuntimeManager.getHttpEndpointUrl(targetMcpServerId);
        if (!url) {
          throw new Error(
            "No HTTP endpoint URL found for streamable-http server",
          );
        }

        // Look up stored session metadata for multi-replica support.
        // In multi-replica MCP server deployments, we must resume sessions
        // against the same pod endpoint where the session was created.
        let sessionId: string | undefined;
        let endpointUrl = url;
        let sessionEndpointPodName: string | null = null;
        if (connectionKey) {
          const stored =
            await McpHttpSessionModel.findRecordByConnectionKey(connectionKey);
          if (stored) {
            sessionId = stored.sessionId;
            endpointUrl = stored.sessionEndpointUrl || endpointUrl;
            sessionEndpointPodName = stored.sessionEndpointPodName;
            logger.debug(
              {
                connectionKey,
                sessionId,
                endpointUrl,
                sessionEndpointPodName,
              },
              "Using stored MCP HTTP session metadata",
            );
          } else if (
            config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster
          ) {
            const runningPodEndpoint =
              await McpServerRuntimeManager.getRunningPodHttpEndpoint(
                targetMcpServerId,
              );
            if (runningPodEndpoint) {
              endpointUrl = runningPodEndpoint.endpointUrl;
              sessionEndpointPodName = runningPodEndpoint.podName;
            }
          }

          this.pendingHttpSessionMetadata.set(connectionKey, {
            sessionEndpointUrl: endpointUrl,
            sessionEndpointPodName,
          });
        }

        const localHeaders: Record<string, string> = {};
        if (tokenAuth?.isExternalIdp && tokenAuth.rawToken) {
          localHeaders.Authorization = `Bearer ${tokenAuth.rawToken}`;
        } else if (secrets.access_token) {
          localHeaders.Authorization = `Bearer ${secrets.access_token}`;
        } else if (secrets.raw_access_token) {
          localHeaders.Authorization = String(secrets.raw_access_token);
        }

        return new StreamableHTTPClientTransport(new URL(endpointUrl), {
          sessionId,
          requestInit: { headers: new Headers(localHeaders) },
        });
      }

      if (catalogItem.serverType === "remote") {
        if (!catalogItem.serverUrl) {
          throw new Error("Remote server missing serverUrl");
        }

        const headers: Record<string, string> = {};
        if (tokenAuth?.isExternalIdp && tokenAuth.rawToken) {
          // Propagate external IdP JWT to the underlying MCP server
          headers.Authorization = `Bearer ${tokenAuth.rawToken}`;
        } else if (secrets.access_token) {
          headers.Authorization = `Bearer ${secrets.access_token}`;
        } else if (secrets.raw_access_token) {
          headers.Authorization = String(secrets.raw_access_token);
        }

        return new StreamableHTTPClientTransport(
          new URL(catalogItem.serverUrl),
          {
            requestInit: { headers: new Headers(headers) },
          },
        );
      }
    }

    if (transportKind === "stdio") {
      if (catalogItem.serverType !== "local") {
        throw new Error("Stdio transport is only supported for local servers");
      }

      // Stdio transport - use K8s attach!
      // Use getOrLoadDeployment to handle multi-replica scenarios where the deployment
      // may have been created by a different replica
      const k8sDeployment =
        await McpServerRuntimeManager.getOrLoadDeployment(targetMcpServerId);
      if (!k8sDeployment) {
        throw new Error("Deployment not found for MCP server");
      }

      const podName = await k8sDeployment.getRunningPodName();
      if (!podName) {
        throw new Error("No running pod found for MCP server deployment");
      }

      return new K8sAttachTransport({
        k8sAttach: k8sDeployment.k8sAttachClient,
        namespace: k8sDeployment.k8sNamespace,
        podName: podName,
        containerName: "mcp-server",
      });
    }

    throw new Error(`Unsupported transport kind: ${transportKind}`);
  }

  private async getTransport(
    catalogItem: InternalMcpCatalog,
    targetMcpServerId: string,
    secrets: Record<string, unknown>,
    connectionKey?: string,
    tokenAuth?: TokenAuthContext,
  ): Promise<Transport> {
    const transportKind = await this.getTransportKind(
      catalogItem,
      targetMcpServerId,
    );
    return this.getTransportWithKind(
      catalogItem,
      targetMcpServerId,
      secrets,
      transportKind,
      connectionKey,
      tokenAuth,
    );
  }

  /**
   * Strip server prefix from tool name
   * Slugifies the prefix using ToolModel.slugifyName to match how tool names are created
   */
  private stripServerPrefix(toolName: string, prefixName: string): string {
    // Slugify the prefix the same way ToolModel.slugifyName does
    const slugifiedPrefix = ToolModel.slugifyName(prefixName, "");

    if (toolName.toLowerCase().startsWith(slugifiedPrefix)) {
      return toolName.substring(slugifiedPrefix.length);
    }
    return toolName;
  }

  /**
   * Resolve the actual tool name from the remote MCP server.
   * Tool names in our DB are lowercased by slugifyName(), but remote servers may use
   * different casing (e.g., camelCase). This method queries the server's tool list
   * and matches case-insensitively to find the correct name.
   */
  private async resolveActualToolName(
    client: Client,
    connectionKey: string,
    strippedToolName: string,
  ): Promise<string> {
    let nameMap = this.toolNameCache.get(connectionKey);
    if (!nameMap) {
      try {
        const toolsResult = await client.listTools();
        nameMap = new Map<string, string>();
        for (const tool of toolsResult.tools) {
          nameMap.set(tool.name.toLowerCase(), tool.name);
        }
        this.toolNameCache.set(connectionKey, nameMap);
      } catch (error) {
        logger.warn(
          { connectionKey, err: error },
          "Failed to list tools for name resolution, using stripped name as-is",
        );
        return strippedToolName;
      }
    }
    return nameMap.get(strippedToolName.toLowerCase()) ?? strippedToolName;
  }

  /**
   * Apply response modifier template with fallback
   */
  private applyTemplate(
    content: unknown,
    template: string | null,
    toolName: string,
  ): unknown {
    if (!template) {
      return content;
    }

    try {
      return applyResponseModifierTemplate(template, content);
    } catch (error) {
      logger.error(
        { err: error },
        `Error applying response modifier template for tool ${toolName}`,
      );
      return content; // Fallback to original
    }
  }

  /**
   * Create and persist an error result
   */
  private async createErrorResult(
    toolCall: CommonToolCall,
    agentId: string,
    error: string,
    mcpServerName: string = "unknown",
    authInfo?: {
      userId?: string;
      authMethod?: MCPGatewayAuthMethod;
    },
  ): Promise<CommonToolResult> {
    const errorResult: CommonToolResult = {
      id: toolCall.id,
      name: toolCall.name,
      content: [{ type: "text", text: error }],
      isError: true,
      error,
    };

    await this.persistToolCall(
      agentId,
      mcpServerName,
      toolCall,
      errorResult,
      authInfo,
    );
    return errorResult;
  }

  /**
   * Create success result with template application
   */
  private async createSuccessResult(
    toolCall: CommonToolCall,
    agentId: string,
    mcpServerName: string,
    content: unknown,
    isError: boolean,
    template: string | null,
    authInfo?: {
      userId?: string;
      authMethod?: MCPGatewayAuthMethod;
    },
  ): Promise<CommonToolResult> {
    const modifiedContent = this.applyTemplate(
      content,
      template,
      toolCall.name,
    );

    const toolResult: CommonToolResult = {
      id: toolCall.id,
      name: toolCall.name,
      content: modifiedContent,
      isError,
    };

    await this.persistToolCall(
      agentId,
      mcpServerName,
      toolCall,
      toolResult,
      authInfo,
    );
    return toolResult;
  }

  /**
   * Attempt to recover from an authentication error by refreshing the OAuth token
   * and retrying the tool call.
   *
   * @returns The result of the retried tool call, or null if refresh failed
   */
  private async attemptTokenRefreshAndRetry(params: {
    secretId: string;
    catalogId: string;
    connectionKey: string;
    toolCall: CommonToolCall;
    agentId: string;
    mcpServerName: string;
    catalogItem: InternalMcpCatalog;
    targetMcpServerId: string;
    executeRetry: (
      getTransport: () => Promise<Transport>,
      secrets: Record<string, unknown>,
    ) => Promise<CommonToolResult>;
  }): Promise<CommonToolResult | null> {
    const {
      secretId,
      catalogId,
      connectionKey,
      toolCall,
      agentId,
      mcpServerName,
      catalogItem,
      targetMcpServerId,
      executeRetry,
    } = params;

    logger.info(
      { toolName: toolCall.name, secretId, catalogId },
      "attemptTokenRefreshAndRetry: authentication error detected, attempting token refresh and retry",
    );

    // Invalidate existing client since token is going to be changed
    const existingClient = this.activeConnections.get(connectionKey);
    if (existingClient) {
      try {
        await existingClient.close();
      } catch {
        // Ignore close errors
      }
      this.activeConnections.delete(connectionKey);
      this.pendingHttpSessionMetadata.delete(connectionKey);
    }

    // Attempt refresh
    const refreshResult = await refreshOAuthToken(secretId, catalogId);

    if (!refreshResult) {
      logger.warn(
        { toolName: toolCall.name, secretId },
        "attemptTokenRefreshAndRetry: token refresh failed",
      );

      // Track the refresh failure in the MCP server record
      await McpServerModel.update(targetMcpServerId, {
        oauthRefreshError: "refresh_failed",
        oauthRefreshFailedAt: new Date(),
      });

      return null;
    }

    logger.info(
      { toolName: toolCall.name, secretId },
      "attemptTokenRefreshAndRetry: token refreshed, retrying tool call",
    );

    // Clear any previous refresh error since refresh succeeded
    await McpServerModel.update(targetMcpServerId, {
      oauthRefreshError: null,
      oauthRefreshFailedAt: null,
    });

    try {
      // Re-fetch updated secrets and retry once
      const updatedSecret = await secretManager().getSecret(secretId);
      if (!updatedSecret?.secret) {
        logger.warn(
          { toolName: toolCall.name, secretId },
          "attemptTokenRefreshAndRetry: failed to fetch updated secret after refresh",
        );
        return null;
      }

      // Create new transport with updated secrets
      const getUpdatedTransport = () =>
        this.getTransport(catalogItem, targetMcpServerId, updatedSecret.secret);

      return await executeRetry(getUpdatedTransport, updatedSecret.secret);
    } catch (retryError) {
      const retryErrorMsg =
        retryError instanceof Error ? retryError.message : String(retryError);
      logger.error(
        { toolName: toolCall.name, error: retryErrorMsg },
        "attemptTokenRefreshAndRetry: retry after token refresh also failed",
      );
      return await this.createErrorResult(
        toolCall,
        agentId,
        retryErrorMsg,
        mcpServerName,
      );
    }
  }

  /**
   * Persist tool call to database with error handling.
   * Skips browser tools to prevent DB bloat from frequent screenshot calls.
   * Truncates large tool results to prevent excessive storage.
   */
  private async persistToolCall(
    agentId: string,
    mcpServerName: string,
    toolCall: CommonToolCall,
    toolResult: CommonToolResult,
    authInfo?: {
      userId?: string;
      authMethod?: MCPGatewayAuthMethod;
    },
  ): Promise<void> {
    // Skip high-frequency browser tool logging to prevent DB bloat
    // (screenshots every ~2s, tab list checks, viewport resizes)
    if (isHighFrequencyBrowserTool(toolCall.name)) {
      return;
    }

    try {
      const savedToolCall = await McpToolCallModel.create({
        agentId,
        mcpServerName,
        method: "tools/call",
        toolCall,
        toolResult,
        userId: authInfo?.userId ?? null,
        authMethod: authInfo?.authMethod ?? null,
      });

      const logData: {
        id: string;
        toolName: string;
        error?: string;
        resultContent?: string;
      } = {
        id: savedToolCall.id,
        toolName: toolCall.name,
      };

      if (toolResult.isError) {
        logData.error = toolResult.error;
      } else {
        logData.resultContent = previewToolResultContent(
          toolResult.content,
          100,
        );
      }

      logger.info(
        logData,
        `✅ Saved MCP tool call (${toolResult.isError ? "error" : "success"}):`,
      );
    } catch (dbError) {
      logger.error({ err: dbError }, "Failed to persist MCP tool call");
    }
  }

  /**
   * Create a timeout promise
   */
  private createTimeout(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }

  /**
   * Connect to an MCP server and return available tools
   */
  async connectAndGetTools(params: {
    catalogItem: InternalMcpCatalog;
    mcpServerId: string;
    secrets: Record<string, unknown>;
  }): Promise<CommonMcpToolDefinition[]> {
    const { catalogItem, mcpServerId, secrets } = params;

    // For local servers, retry connection a few times since the MCP server process
    // may need time to initialize even after the pod is ready
    const maxRetries = catalogItem.serverType === "local" ? 3 : 1;
    const retryDelayMs = 5000; // 5 seconds between retries

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get the appropriate transport using the existing helper
        const transport = await this.getTransport(
          catalogItem,
          mcpServerId,
          secrets,
        );

        // Create client with transport
        const client = new Client(
          {
            name: "archestra-platform",
            version: "1.0.0",
          },
          {
            capabilities: {},
          },
        );

        // Connect with timeout
        await Promise.race([
          client.connect(transport),
          this.createTimeout(30000, "Connection timeout after 30 seconds"),
        ]);

        // List tools with timeout
        const toolsResult = await Promise.race([
          client.listTools(),
          this.createTimeout(30000, "List tools timeout after 30 seconds"),
        ]);

        // Close connection (we just needed the tools)
        await client.close();

        // Transform tools to our format
        return toolsResult.tools.map((tool: Tool) => ({
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        }));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Unknown error");

        // If this is not the last attempt, log and retry
        if (attempt < maxRetries) {
          logger.warn(
            { attempt, maxRetries, err: error },
            `Failed to connect to MCP server ${catalogItem.name} (attempt ${attempt}/${maxRetries}). Retrying in ${retryDelayMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }

        // Last attempt failed, throw error
        throw new Error(
          `Failed to connect to MCP server ${catalogItem.name}: ${lastError.message}`,
        );
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error(
      `Failed to connect to MCP server ${catalogItem.name}: ${
        lastError?.message || "Unknown error"
      }`,
    );
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (client) {
      try {
        await client.close();
      } catch (error) {
        logger.error({ err: error }, `Error closing MCP client ${clientId}:`);
      }
      this.clients.delete(clientId);
    }
  }

  /**
   * Disconnect from all MCP servers
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.clients.keys()).map((clientId) =>
      this.disconnect(clientId),
    );

    // Also disconnect active connections
    const activeDisconnectPromises = Array.from(
      this.activeConnections.values(),
    ).map(async (client) => {
      try {
        await client.close();
      } catch (error) {
        logger.error({ err: error }, "Error closing active MCP connection:");
      }
    });

    await Promise.all([...disconnectPromises, ...activeDisconnectPromises]);
    this.activeConnections.clear();
    this.pendingHttpSessionMetadata.clear();
  }
}

/**
 * Check if a browser tool is high-frequency and should skip logging.
 * Screenshots (~2s interval), tab list checks, and viewport resizes
 * generate too many log entries. Other browser actions (navigate, click,
 * type, snapshot, etc.) are logged normally.
 */
function isHighFrequencyBrowserTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name.includes("browser_take_screenshot") ||
    name.includes("browser_screenshot") ||
    name.includes("browser_tabs") ||
    name.includes("browser_resize")
  );
}

// Singleton instance
const mcpClient = new McpClient();
export default mcpClient;

// Clean up connections on process exit
process.on("exit", () => {
  mcpClient.disconnectAll().catch(logger.error);
});

process.on("SIGINT", () => {
  mcpClient.disconnectAll().catch(logger.error);
  process.exit(0);
});

process.on("SIGTERM", () => {
  mcpClient.disconnectAll().catch(logger.error);
  process.exit(0);
});
