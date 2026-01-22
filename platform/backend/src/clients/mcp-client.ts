import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import config from "@/config";
import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import {
  InternalMcpCatalogModel,
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
} from "@/types";
import { previewToolResultContent } from "@/utils/tool-result-preview";
import { K8sAttachTransport } from "./k8s-attach-transport";

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
  /** True if this is a personal user token */
  isUserToken?: boolean;
  /** Optional user ID for user-owned server priority (set when called from chat or from user token) */
  userId?: string;
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

  /**
   * Execute a single tool call against its assigned MCP server
   */
  async executeToolCall(
    toolCall: CommonToolCall,
    agentId: string,
    tokenAuth?: TokenAuthContext,
  ): Promise<CommonToolResult> {
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

    // Build connection cache key using the resolved target server ID
    // This ensures each user gets their own connection for dynamic credentials
    const connectionKey = `${catalogItem.id}:${targetMcpServerId}`;

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
        );
      } catch (error) {
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
        );
      }
    };

    if (!this.shouldLimitConcurrency()) {
      return executeToolCall(
        () => this.getTransport(catalogItem, targetMcpServerId, secrets),
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

    await client.connect(transport);

    // Store the connection for reuse
    this.activeConnections.set(connectionKey, client);

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
    // Get MCP tool
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

    // Priority 2: Team token used - we check try to use token without teamId first to prioritize personal credential
    if (tokenAuth.teamId) {
      for (const server of allServers) {
        if (server.ownerId && !server.teamId) {
          const ownerInTeam = await TeamModel.isUserInTeam(
            tokenAuth.teamId,
            server.ownerId,
          );
          if (ownerInTeam) {
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
      }
    }

    // Priority 3: Team token used - we try to find any token from team
    if (tokenAuth.teamId) {
      for (const server of allServers) {
        if (server.ownerId) {
          const ownerInTeam = await TeamModel.isUserInTeam(
            tokenAuth.teamId,
            server.ownerId,
          );
          if (ownerInTeam) {
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

    // No server found, throw an error
    const context = tokenAuth.userId
      ? `user: ${tokenAuth.userId}`
      : tokenAuth.teamId
        ? `team: ${tokenAuth.teamId}`
        : "organization";
    return {
      error: await this.createErrorResult(
        toolCall,
        agentId,
        `No installation found for catalog ${tool.catalogName || tool.catalogId} with ${context}. Ensure an MCP server installation exists.`,
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
  ): Promise<Transport> {
    if (transportKind === "http") {
      if (catalogItem.serverType === "local") {
        const url =
          McpServerRuntimeManager.getHttpEndpointUrl(targetMcpServerId);
        if (!url) {
          throw new Error(
            "No HTTP endpoint URL found for streamable-http server",
          );
        }

        return new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: new Headers({}) },
        });
      }

      if (catalogItem.serverType === "remote") {
        if (!catalogItem.serverUrl) {
          throw new Error("Remote server missing serverUrl");
        }

        const headers: Record<string, string> = {};
        if (secrets.access_token) {
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
  ): Promise<CommonToolResult> {
    const errorResult: CommonToolResult = {
      id: toolCall.id,
      name: toolCall.name,
      content: null,
      isError: true,
      error,
    };

    await this.persistToolCall(agentId, mcpServerName, toolCall, errorResult);
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

    await this.persistToolCall(agentId, mcpServerName, toolCall, toolResult);
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
   * Persist tool call to database with error handling
   */
  private async persistToolCall(
    agentId: string,
    mcpServerName: string,
    toolCall: CommonToolCall,
    toolResult: CommonToolResult,
  ): Promise<void> {
    try {
      const savedToolCall = await McpToolCallModel.create({
        agentId,
        mcpServerName,
        method: "tools/call",
        toolCall,
        toolResult,
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
  }
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
