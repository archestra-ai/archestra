import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ContentBlock,
  ReadResourceResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type AssignedCredentialUnavailableMcpToolError,
  type AuthExpiredMcpToolError,
  type AuthRequiredMcpToolError,
  LINKED_IDP_SSO_MODE,
  MCP_APPS_CLIENT_EXTENSION_CAPABILITIES,
  MCP_CATALOG_INSTALL_PATH,
  MCP_CATALOG_INSTALL_QUERY_PARAM,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
  MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  type McpToolError,
  parseFullToolName,
  TimeInMs,
} from "@shared";
import QuickLRU from "quick-lru";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import {
  InternalMcpCatalogModel,
  McpHttpSessionModel,
  McpServerModel,
  McpToolCallModel,
  TeamModel,
  ToolModel,
} from "@/models";
import { discoverOAuthEndpoints, refreshOAuthToken } from "@/routes/oauth";
import { secretManager } from "@/secrets-manager";
import {
  type ResolvedEnterpriseTransportCredential,
  resolveEnterpriseTransportCredential,
} from "@/services/identity-providers/enterprise-managed/broker";
import { findExternalIdentityProviderById } from "@/services/identity-providers/oidc";
import type {
  CommonMcpToolDefinition,
  CommonToolCall,
  CommonToolResult,
  EnterpriseManagedCredentialConfig,
  InternalMcpCatalog,
  MCPGatewayAuthMethod,
  McpToolAssignment,
} from "@/types";
import type { ClientCapabilitiesWithExtensions } from "@/types/mcp-capabilities";
import { deriveAuthMethod } from "@/utils/auth-method";
import { buildMcpClientInfo } from "@/utils/mcp-client-info";
import { previewToolResultContent } from "@/utils/tool-result-preview";
import { K8sAttachTransport } from "./k8s-attach-transport";

const MCP_CLIENT_EXTENSION_CAPABILITIES = {
  ...MCP_APPS_CLIENT_EXTENSION_CAPABILITIES,
  ...MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
} as const;

export class McpServerNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerNotReadyError";
  }
}

export class McpServerConnectionTimeoutError extends Error {
  constructor(
    message = "MCP server did not become reachable within 30 seconds. Verify its configuration and runtime logs, then try again.",
  ) {
    super(message);
    this.name = "McpServerConnectionTimeoutError";
  }
}

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
  /** True if authenticated via browser session (MCP proxy route) */
  isSessionAuth?: boolean;
  /** Headers to forward to downstream MCP servers (extracted from incoming request per gateway allowlist) */
  passthroughHeaders?: Record<string, string>;
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
const OAUTH_TOKEN_REFRESH_BUFFER_MS = 5 * TimeInMs.Minute;
const CLIENT_CREDENTIALS_FALLBACK_TTL_MS = 5 * TimeInMs.Minute;
// Idle TTL for shared MCP active connections. These clients can retain HTTP
// session affinity, tool-name caches, and browser-backed remote state, so we
// want them to age out after inactivity instead of accumulating forever.
// Fifteen minutes keeps sequential tool calls in an active chat warm while
// reclaiming abandoned connections on a reasonable operational timescale.
const ACTIVE_CONNECTION_CACHE_TTL_MS = 15 * TimeInMs.Minute;
const ACTIVE_CONNECTION_CACHE_MAX_SIZE = 500;

const RESOURCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const RESOURCE_CACHE_MAX_SIZE = 1000;

type ResourceContents = { contents: ReadResourceResult["contents"] };

type CachedResource = {
  result: ResourceContents;
  ttl: number;
};

type CachedServerState = {
  secretId: string | null;
};

class McpClient {
  private static readonly TOOL_NAME_CACHE_MAX_ENTRIES = 1_000;
  private static readonly SECRETS_CACHE_MAX_ENTRIES = 1_000;
  private static readonly SECRETS_CACHE_TTL_MS = 30_000;
  private static readonly ENTERPRISE_CREDENTIAL_CACHE_MAX_ENTRIES = 1_000;
  private static readonly ENTERPRISE_CREDENTIAL_CACHE_FALLBACK_TTL_MS = 30_000;

  private clients = new Map<string, Client>();
  private activeConnections = new LRUCacheManager<Client>({
    maxSize: ACTIVE_CONNECTION_CACHE_MAX_SIZE,
    defaultTtl: ACTIVE_CONNECTION_CACHE_TTL_MS,
    onEviction: (key: string, value: unknown) => {
      const client = value as Client;
      Promise.resolve(client.close()).catch((error) => {
        logger.warn(
          { connectionKey: key, error },
          "Error closing evicted active MCP connection",
        );
      });
      this.activeConnectionServerState.delete(key);
      this.toolNameCache.delete(key);
      this.pendingHttpSessionMetadata.delete(key);
    },
  });
  private activeConnectionServerState = new Map<string, CachedServerState>();
  private connectionLimiter = new ConnectionLimiter();
  // Cache of actual tool names per connection key: lowercased name -> original cased name
  private toolNameCache = new LRUCacheManager<Map<string, string>>({
    maxSize: McpClient.TOOL_NAME_CACHE_MAX_ENTRIES,
    defaultTtl: 0,
  });
  // Per-connectionKey lock to prevent thundering-herd when multiple concurrent
  // calls (e.g. browser stream ticks) detect a stale session simultaneously.
  // Only the first caller performs cleanup + retry; others wait and reuse.
  private sessionRecoveryLocks = new Map<string, Promise<void>>();
  // Per-secretId lock to prevent concurrent OAuth refresh attempts from
  // thrashing rotating refresh tokens when multiple tool calls arrive at once.
  private oauthRefreshLocks = new Map<
    string,
    Promise<{
      refreshed: boolean;
      updatedSecret: Record<string, unknown> | null;
    }>
  >();
  // Session affinity metadata discovered during transport creation.
  // Used when persisting fresh session IDs after connect().
  private pendingHttpSessionMetadata = new Map<
    string,
    { sessionEndpointUrl: string | null; sessionEndpointPodName: string | null }
  >();
  // Cache for resource reads: key is `${agentId}:${uri}`, value is cached result with TTL.
  // Bounded to RESOURCE_CACHE_MAX_SIZE entries (LRU eviction) to prevent unbounded growth
  // in multi-tenant environments with many agents and resources.
  private resourceCache = new QuickLRU<string, CachedResource>({
    maxSize: RESOURCE_CACHE_MAX_SIZE,
  });
  // Short-lived cache for MCP server secrets to avoid N+1 queries when multiple
  // tool calls hit the same MCP server within a batch or concurrent request window.
  private secretsCache = new LRUCacheManager<{
    secrets: Record<string, unknown>;
    secretId?: string;
  }>({
    maxSize: McpClient.SECRETS_CACHE_MAX_ENTRIES,
    defaultTtl: McpClient.SECRETS_CACHE_TTL_MS,
  });
  private enterpriseCredentialCache =
    new LRUCacheManager<ResolvedEnterpriseTransportCredential>({
      maxSize: McpClient.ENTERPRISE_CREDENTIAL_CACHE_MAX_ENTRIES,
      defaultTtl: McpClient.ENTERPRISE_CREDENTIAL_CACHE_FALLBACK_TTL_MS,
    });
  private clientCredentialsLocks = new Map<
    string,
    Promise<Record<string, unknown>>
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
      this.activeConnectionServerState.delete(connectionKey);
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
    options?: {
      conversationId?: string;
      identityProviderRedirectPath?: string;
    },
  ): Promise<CommonToolResult> {
    // Derive auth info for logging
    const authInfo =
      tokenAuth && Object.keys(tokenAuth).length
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
    const { tool, catalogItem, resolvedToolCall } = validationResult;
    // Use the resolved name (may have been prefixed by suffix fallback lookup)
    toolCall = resolvedToolCall;

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
    const { targetMcpServerId, mcpServerName } = targetMcpServerIdResult;
    const _targetMcpServer = await McpServerModel.findById(targetMcpServerId);
    const effectiveEnterpriseManagedConfig =
      catalogItem.enterpriseManagedConfig ?? null;
    if (
      tool.credentialResolutionMode === "enterprise_managed" &&
      !effectiveEnterpriseManagedConfig
    ) {
      return this.createErrorResult(
        toolCall,
        agentId,
        "Enterprise-managed credentials are enabled for this tool, but the MCP catalog item does not have enterprise-managed credential settings configured.",
        mcpServerName,
        authInfo,
      );
    }
    const enterpriseTransportCredential =
      tool.credentialResolutionMode === "enterprise_managed"
        ? await this.resolveCachedEnterpriseTransportCredential({
            agentId,
            tokenAuth,
            enterpriseManagedConfig: effectiveEnterpriseManagedConfig,
          })
        : null;

    if (
      tool.credentialResolutionMode === "enterprise_managed" &&
      !enterpriseTransportCredential
    ) {
      const authError =
        await this.buildEnterpriseManagedIdentityProviderAuthMessage(
          catalogItem.name,
          catalogItem.id,
          effectiveEnterpriseManagedConfig?.identityProviderId ?? null,
          tokenAuth,
          options,
        );
      return this.createErrorResult(
        toolCall,
        agentId,
        authError.message,
        mcpServerName,
        authInfo,
        authError,
      );
    }

    const secretsResult = await this.getSecretsForMcpServer({
      targetMcpServerId: targetMcpServerId,
      toolCall,
      agentId,
    });
    if ("error" in secretsResult) {
      return secretsResult.error;
    }
    const { secrets, secretId, serverState } = secretsResult;

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
        const hasRefreshToken = !!(currentSecrets as { refresh_token?: string })
          .refresh_token;
        const shouldRefreshBeforeCall =
          !isRetry &&
          !!catalogItem.oauthConfig &&
          !!secretId &&
          hasRefreshToken &&
          shouldProactivelyRefreshOAuthToken(currentSecrets);

        if (shouldRefreshBeforeCall) {
          const retryToolCallResult = await this.attemptTokenRefreshAndRetry({
            secretId,
            catalogId: catalogItem.id,
            connectionKey,
            toolCall,
            agentId,
            mcpServerName,
            catalogItem,
            targetMcpServerId,
            tokenAuth,
            toolCatalogId: tool.catalogId,
            toolCatalogName: tool.catalogName,
            executeRetry: (nextGetTransport, secrets) =>
              executeToolCall(nextGetTransport, secrets, true),
          });

          if (retryToolCallResult) {
            return retryToolCallResult;
          }

          logger.warn(
            { toolName: toolCall.name, secretId, catalogId: catalogItem.id },
            "Proactive OAuth refresh failed, falling back to existing token",
          );
        }

        // Get the appropriate transport
        const transport = await getTransport();

        // Get or create client
        const client = await this.getOrCreateClient(
          connectionKey,
          transport,
          targetMcpServerId,
          serverState,
        );

        // Determine the actual tool name by stripping the server/catalog prefix.
        // We prioritize the `catalogName` prefix, which is standard for local MCP servers.
        // If the tool name doesn't match the catalog prefix, we fall back to the resolved `mcpServerName`.
        let targetToolName = this.stripServerPrefix(
          toolCall.name,
          tool.catalogName || "",
        );

        if (targetToolName === toolCall.name) {
          // No prefix match with catalogName; attempt to strip using mcpServerName instead.
          targetToolName = this.stripServerPrefix(toolCall.name, mcpServerName);
        }

        if (targetToolName === toolCall.name) {
          // Neither prefix matched (e.g. server name contains MCP_SERVER_TOOL_NAME_SEPARATOR separator).
          // Fall back to parseFullToolName which uses lastIndexOf to split correctly.
          targetToolName = parseFullToolName(toolCall.name).toolName;
        }

        const resourceUri = getSyntheticResourceToolUri(tool.meta);
        if (resourceUri) {
          const result = await client.readResource({ uri: resourceUri });
          return await this.createSuccessResult({
            toolCall,
            agentId,
            mcpServerName,
            content: [
              {
                type: "text",
                text: JSON.stringify(result.contents),
              },
            ],
            isError: false,
            _meta: { resourceUri },
            authInfo,
            structuredContent: {
              contents: result.contents as unknown,
            },
          });
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

        const isOAuthServer = !!catalogItem.oauthConfig;
        const toolResultAuthError = isAuthRelatedToolResult(result);
        if (
          toolResultAuthError &&
          isOAuthServer &&
          secretId &&
          hasRefreshToken &&
          !isRetry
        ) {
          const retryToolCallResult = await this.attemptTokenRefreshAndRetry({
            secretId,
            catalogId: catalogItem.id,
            connectionKey,
            toolCall,
            agentId,
            mcpServerName,
            catalogItem,
            targetMcpServerId,
            tokenAuth,
            toolCatalogId: tool.catalogId,
            toolCatalogName: tool.catalogName,
            executeRetry: (nextGetTransport, secrets) =>
              executeToolCall(nextGetTransport, secrets, true),
          });

          if (retryToolCallResult) {
            return retryToolCallResult;
          }
        }

        if (toolResultAuthError && tool.catalogId && targetMcpServerId) {
          const catalogDisplayName = tool.catalogName || tool.catalogId;
          const authError = this.buildExpiredAuthMessage(
            catalogDisplayName,
            tool.catalogId,
            targetMcpServerId,
            tokenAuth,
          );
          return await this.createErrorResult(
            toolCall,
            agentId,
            authError.message,
            mcpServerName,
            authInfo,
            authError,
          );
        }

        // Apply template and return
        return await this.createSuccessResult({
          toolCall,
          agentId,
          mcpServerName,
          content: result.content as ContentBlock[],
          isError: !!result.isError,
          _meta: result._meta,
          authInfo,
          structuredContent: result.structuredContent as
            | Record<string, unknown>
            | undefined,
        });
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
            this.activeConnectionServerState.delete(connectionKey);
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

        // Check if this is an authentication error - either by type/status code
        // or by detecting auth-related keywords in the error message (some servers
        // return non-401 status codes with auth error messages in the body)
        const isAuthError =
          error instanceof UnauthorizedError ||
          (error instanceof StreamableHTTPError && error.code === 401) ||
          isAuthRelatedError(errorMessage);

        // Only attempt token refresh for OAuth servers with a refresh token
        const isOAuthServer = !!catalogItem.oauthConfig;
        const usesClientCredentials = usesOAuthClientCredentials(catalogItem);
        const hasRefreshToken = !!(currentSecrets as { refresh_token?: string })
          .refresh_token;

        // Track and skip recovery if no refresh token available
        if (
          isAuthError &&
          isOAuthServer &&
          targetMcpServerId &&
          !hasRefreshToken &&
          !usesClientCredentials
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
            mcpServerName,
            catalogItem,
            targetMcpServerId,
            tokenAuth,
            toolCatalogId: tool.catalogId,
            toolCatalogName: tool.catalogName,
            executeRetry: (getTransport, secrets) =>
              executeToolCall(getTransport, secrets, true),
          });

          if (retryToolCallResult) {
            return retryToolCallResult;
          }
          // If recovery returned null, the error was already recorded in attemptTokenRefreshAndRetry
        }

        if (!isRetry && isAuthError && usesClientCredentials && secretId) {
          const resetSecrets = {
            ...currentSecrets,
            access_token: null,
            client_credentials_expires_at: null,
            client_credentials_refresh_at: null,
          };
          await secretManager().updateSecret(secretId, resetSecrets);
          this.secretsCache.set(targetMcpServerId, {
            secrets: resetSecrets,
            secretId,
          });
          this.activeConnections.delete(connectionKey);
          this.activeConnectionServerState.delete(connectionKey);
          this.toolNameCache.delete(connectionKey);
          this.pendingHttpSessionMetadata.delete(connectionKey);

          return await executeToolCall(
            () =>
              this.getTransport(
                catalogItem,
                targetMcpServerId,
                resetSecrets,
                secretId,
                connectionKey,
                tokenAuth,
                enterpriseTransportCredential ?? undefined,
              ),
            resetSecrets,
            true,
          );
        }

        // For auth errors, return an actionable message with re-auth URL
        if (isAuthError && tool.catalogId) {
          const catalogDisplayName = tool.catalogName || tool.catalogId;
          // Credentials exist but failed → "expired/invalid" message with manage link
          if (targetMcpServerId) {
            const targetServer =
              await McpServerModel.findById(targetMcpServerId);
            if (
              targetServer?.ownerId &&
              !targetServer.teamId &&
              tokenAuth?.userId !== targetServer.ownerId
            ) {
              const assignmentError =
                this.buildAssignedCredentialUnavailableMessage(
                  catalogDisplayName,
                  tool.catalogId,
                );
              return await this.createErrorResult(
                toolCall,
                agentId,
                assignmentError.message,
                mcpServerName,
                authInfo,
                assignmentError,
              );
            }
            const authError = this.buildExpiredAuthMessage(
              catalogDisplayName,
              tool.catalogId,
              targetMcpServerId,
              tokenAuth,
            );
            return await this.createErrorResult(
              toolCall,
              agentId,
              authError.message,
              mcpServerName,
              authInfo,
              authError,
            );
          }
          // No server resolved → "auth required" message with install link
          const authError = this.buildAuthRequiredMessage(
            catalogDisplayName,
            tool.catalogId,
            tokenAuth,
          );
          return await this.createErrorResult(
            toolCall,
            agentId,
            authError.message,
            mcpServerName,
            authInfo,
            authError,
          );
        }

        return await this.createErrorResult(
          toolCall,
          agentId,
          errorMessage,
          mcpServerName,
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
            secretId,
            connectionKey,
            tokenAuth,
            enterpriseTransportCredential ?? undefined,
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
        executeToolCall(async () => {
          const resolvedSecrets = await this.resolveSecretsForTransport({
            catalogItem,
            secrets,
            secretId,
          });
          if (resolvedSecrets !== secrets) {
            this.secretsCache.set(targetMcpServerId, {
              secrets: resolvedSecrets,
              ...(secretId ? { secretId } : {}),
            });
          }

          return this.getTransportWithKind(
            catalogItem,
            targetMcpServerId,
            resolvedSecrets,
            transportKind,
            connectionKey,
            tokenAuth,
            enterpriseTransportCredential ?? undefined,
          );
        }, secrets),
    );
  }

  /**
   * Get or create a client with the given transport
   */
  private async getOrCreateClient(
    connectionKey: string,
    transport: Transport,
    targetMcpServerId: string,
    currentServerState: CachedServerState,
  ): Promise<Client> {
    // Check if we already have an active connection
    const existingClient = this.activeConnections.get(connectionKey);
    if (existingClient) {
      const cachedServerState =
        this.activeConnectionServerState.get(connectionKey);
      if (
        !cachedServerState ||
        !this.hasMatchingServerState(cachedServerState, currentServerState)
      ) {
        logger.info(
          {
            connectionKey,
            targetMcpServerId,
            cachedSecretId: cachedServerState?.secretId ?? null,
            currentSecretId: currentServerState.secretId,
          },
          "Discarding cached MCP client after MCP server secret changed",
        );
        try {
          await existingClient.close();
        } catch (error) {
          logger.warn(
            { connectionKey, targetMcpServerId, error },
            "Error closing stale cached MCP client after credential change",
          );
        }
        this.activeConnections.delete(connectionKey);
        this.activeConnectionServerState.delete(connectionKey);
        this.toolNameCache.delete(connectionKey);
        this.pendingHttpSessionMetadata.delete(connectionKey);
      }
    }

    const reusableClient = this.activeConnections.get(connectionKey);
    if (reusableClient) {
      // Health check: ping the client to verify connection is still alive
      try {
        await reusableClient.ping();
        logger.debug(
          { connectionKey },
          "Client ping successful, reusing cached client",
        );
        this.activeConnections.set(connectionKey, reusableClient);
        this.activeConnectionServerState.set(connectionKey, currentServerState);
        return reusableClient;
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
        this.activeConnectionServerState.delete(connectionKey);
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

    // Create the client with UI extension capabilities
    const capabilities: ClientCapabilitiesWithExtensions = {
      roots: { listChanged: true },
      extensions: MCP_CLIENT_EXTENSION_CAPABILITIES,
    };

    // Create new client
    logger.info({ connectionKey }, "Creating new MCP client");
    const client = new Client(buildMcpClientInfo("archestra-platform"), {
      capabilities,
    });

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
    this.activeConnectionServerState.set(connectionKey, currentServerState);

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
    | {
        tool: McpToolAssignment;
        catalogItem: InternalMcpCatalog;
        resolvedToolCall: CommonToolCall;
      }
    | { error: CommonToolResult }
  > {
    // Get MCP tool from agent-assigned tools
    let mcpTools = await ToolModel.getMcpToolsAssignedToAgent(
      [toolCall.name],
      agentId,
    );

    // Fallback: if the name has no server prefix (no MCP_SERVER_TOOL_NAME_SEPARATOR), try finding a tool
    // that ends with "__<name>". This handles MCP App iframes calling oncalltool
    // with the raw tool name (e.g. "refresh-stats" instead of "system__refresh-stats"),
    // which happens when third-party hosts render MCP Apps.
    if (
      mcpTools.length === 0 &&
      !toolCall.name.includes(MCP_SERVER_TOOL_NAME_SEPARATOR)
    ) {
      mcpTools = await ToolModel.getMcpToolsAssignedToAgentBySuffix(
        toolCall.name,
        agentId,
      );
      if (mcpTools.length > 0) {
        // Use the full prefixed name for downstream execution but don't mutate the caller's object.
        toolCall = { ...toolCall, name: mcpTools[0].toolName };
      }
    }

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
          tool.catalogName || "unknown",
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
          tool.catalogName || "unknown",
        ),
      };
    }

    return { tool, catalogItem, resolvedToolCall: toolCall };
  }

  // Gets secrets of a given MCP server, with short-lived caching to prevent
  // N+1 queries when multiple tool calls target the same server.
  private async getSecretsForMcpServer({
    targetMcpServerId,
    toolCall,
    agentId,
  }: {
    targetMcpServerId: string;
    toolCall: CommonToolCall;
    agentId: string;
  }): Promise<
    | {
        secrets: Record<string, unknown>;
        secretId?: string;
        serverState: CachedServerState;
      }
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

    const currentServerState = this.toCachedServerState(mcpServer);
    const cached = this.secretsCache.get(targetMcpServerId);
    if (cached?.secretId === currentServerState.secretId) {
      return { ...cached, serverState: currentServerState };
    }

    if (cached) {
      this.secretsCache.delete(targetMcpServerId);
    }

    const result = await this.fetchSecretsForLoadedMcpServer(mcpServer);

    this.secretsCache.set(targetMcpServerId, {
      secrets: result.secrets,
      secretId: result.secretId,
    });

    return result;
  }

  private async fetchSecretsForLoadedMcpServer(
    mcpServer: NonNullable<Awaited<ReturnType<typeof McpServerModel.findById>>>,
  ): Promise<{
    secrets: Record<string, unknown>;
    secretId?: string;
    serverState: CachedServerState;
  }> {
    const serverState = this.toCachedServerState(mcpServer);
    if (mcpServer.secretId) {
      const secret = await secretManager().getSecret(mcpServer.secretId);
      if (secret?.secret) {
        logger.info(
          {
            targetMcpServerId: mcpServer.id,
            secretId: mcpServer.secretId,
          },
          `Found secrets for MCP server ${mcpServer.id}`,
        );
        return {
          secrets: secret.secret,
          secretId: mcpServer.secretId,
          serverState,
        };
      }
    }
    return { secrets: {}, serverState };
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
    tool: McpToolAssignment;
    toolCall: CommonToolCall;
    agentId: string;
    tokenAuth?: TokenAuthContext;
    catalogItem: InternalMcpCatalog;
  }): Promise<
    | { targetMcpServerId: string; mcpServerName: string }
    | { error: CommonToolResult }
  > {
    const fallbackName = tool.catalogName || "unknown";
    logger.info(
      {
        toolName: toolCall.name,
        tool: tool,
        tokenAuth: tokenAuth,
      },
      "Determining target MCP server ID for catalog item",
    );
    // Static credential case: tool has a bound MCP server credential to use.
    if (tool.credentialResolutionMode === "static") {
      if (!tool.mcpServerId) {
        return {
          error: await this.createErrorResult(
            toolCall,
            agentId,
            "An MCP server installation is required for statically assigned MCP tools.",
            fallbackName,
          ),
        };
      }
      const mcpServer = await McpServerModel.findById(tool.mcpServerId);
      logger.info(
        {
          toolName: toolCall.name,
          catalogItem: catalogItem,
          targetMcpServerId: tool.mcpServerId,
        },
        "Determined target MCP server ID for catalog item",
      );
      return {
        targetMcpServerId: tool.mcpServerId,
        mcpServerName: mcpServer?.name || fallbackName,
      };
    }

    // If mcp server is configured to use enterprise-managed credentials, we can use any pod.
    // Mcp server pod will request credentials from the IDP.
    if (tool.credentialResolutionMode === "enterprise_managed") {
      const explicitTargetMcpServerId = tool.mcpServerId;
      if (explicitTargetMcpServerId) {
        const mcpServer = await McpServerModel.findById(
          explicitTargetMcpServerId,
        );
        return {
          targetMcpServerId: explicitTargetMcpServerId,
          mcpServerName: mcpServer?.name || fallbackName,
        };
      }

      const allServers = await McpServerModel.findByCatalogId(
        tool.catalogId ?? "",
      );
      const resolvedServer = allServers[0];
      if (!resolvedServer) {
        return {
          error: await this.createErrorResult(
            toolCall,
            agentId,
            "Enterprise-managed credentials are configured, but no MCP server installation is available for this catalog.",
            fallbackName,
          ),
        };
      }

      return {
        targetMcpServerId: resolvedServer.id,
        mcpServerName: resolvedServer.name,
      };
    }

    // Dynamic credential (resolved on tool call time) case: resolve target MCP server ID based on tokenAuth
    // tokenAuth are profile tokens autocreated when team is assigned to a profile
    if (!tokenAuth) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          "Dynamic team credential is enabled but no token authentication provided. Use a profile token to authenticate.",
          fallbackName,
        ),
      };
    }
    if (!tool.catalogId) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          "Dynamic team credential is enabled but tool has no catalogId.",
          fallbackName,
        ),
      };
    }

    // Get all servers for this catalog
    const allServers = await McpServerModel.findByCatalogId(tool.catalogId);

    // User token: try user's personal server, then team-owned servers for
    // teams the user belongs to, then fall back to an org-scoped install.
    if (tokenAuth.userId) {
      // Priority 1: Personal credential owned by current user
      const userServer = allServers.find(
        (s) => s.ownerId === tokenAuth.userId && !s.teamId && s.scope !== "org",
      );
      if (userServer) {
        logger.info(
          {
            toolName: toolCall.name,
            catalogId: tool.catalogId,
            serverId: userServer.id,
            userId: tokenAuth.userId,
          },
          `Dynamic resolution: using user-owned server for tool ${toolCall.name}`,
        );
        return {
          targetMcpServerId: userServer.id,
          mcpServerName: userServer.name,
        };
      }

      // Priority 2: Team-owned server for a team the user is a member of
      const userTeams = await TeamModel.getUserTeams(tokenAuth.userId);
      const userTeamIds = new Set(userTeams.map((t) => t.id));
      const teamServer = allServers.find(
        (s) => s.teamId && userTeamIds.has(s.teamId),
      );
      if (teamServer) {
        logger.info(
          {
            toolName: toolCall.name,
            catalogId: tool.catalogId,
            serverId: teamServer.id,
            teamId: teamServer.teamId,
            userId: tokenAuth.userId,
          },
          `Dynamic resolution: using team-owned server for user ${tokenAuth.userId}`,
        );
        return {
          targetMcpServerId: teamServer.id,
          mcpServerName: teamServer.name,
        };
      }

      // Priority 3: Org-scoped install
      const orgServer = allServers.find((s) => s.scope === "org");
      if (orgServer) {
        logger.info(
          {
            toolName: toolCall.name,
            catalogId: tool.catalogId,
            serverId: orgServer.id,
            userId: tokenAuth.userId,
          },
          `Dynamic resolution: using org-scoped server for user ${tokenAuth.userId}`,
        );
        return {
          targetMcpServerId: orgServer.id,
          mcpServerName: orgServer.name,
        };
      }
    }

    // Team token: try team-owned servers for the token's team, then fall back
    // to an org-scoped install.
    if (tokenAuth.teamId) {
      const teamServer = allServers.find((s) => s.teamId === tokenAuth.teamId);
      if (teamServer) {
        logger.info(
          {
            toolName: toolCall.name,
            catalogId: tool.catalogId,
            serverId: teamServer.id,
            teamId: tokenAuth.teamId,
          },
          `Dynamic resolution: using team-owned server for team ${tokenAuth.teamId}`,
        );
        return {
          targetMcpServerId: teamServer.id,
          mcpServerName: teamServer.name,
        };
      }

      const orgServer = allServers.find((s) => s.scope === "org");
      if (orgServer) {
        logger.info(
          {
            toolName: toolCall.name,
            catalogId: tool.catalogId,
            serverId: orgServer.id,
            teamId: tokenAuth.teamId,
          },
          `Dynamic resolution: using org-scoped server for team ${tokenAuth.teamId}`,
        );
        return {
          targetMcpServerId: orgServer.id,
          mcpServerName: orgServer.name,
        };
      }
    }

    // Org-wide token is incompatible with dynamic credential resolution
    if (tokenAuth.isOrganizationToken) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          "Organization-wide tokens are not supported for tools with dynamic credential resolution. Use a personal or team token instead.",
          fallbackName,
        ),
      };
    }

    // Fallback for external IdP users if earlier resolution didn't match
    // TODO: works only we are doing end-to-end JWKS pattern.
    if (tokenAuth.isExternalIdp && allServers.length > 0) {
      logger.info(
        {
          toolName: toolCall.name,
          catalogId: tool.catalogId,
          serverId: allServers[0].id,
        },
        `Dynamic resolution: using first available server for external IdP user`,
      );
      return {
        targetMcpServerId: allServers[0].id,
        mcpServerName: allServers[0].name,
      };
    }

    // No server found - return an actionable error with install link
    const catalogDisplayName = tool.catalogName || tool.catalogId;
    const authError = this.buildAuthRequiredMessage(
      catalogDisplayName,
      tool.catalogId,
      tokenAuth,
    );
    return {
      error: await this.createErrorResult(
        toolCall,
        agentId,
        authError.message,
        fallbackName,
        undefined,
        authError,
      ),
    };
  }

  /**
   * Get appropriate transport based on server type and configuration
   */
  private shouldLimitConcurrency(): boolean {
    return true;
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
    enterpriseTransportCredential?: {
      headerName: string;
      headerValue: string;
    },
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

        const localHeaders = buildStaticCredentialHeaders({
          catalogItem,
          secrets,
        });
        if (enterpriseTransportCredential) {
          localHeaders[enterpriseTransportCredential.headerName] =
            enterpriseTransportCredential.headerValue;
        } else if (
          !hasStaticAuthorizationCredential(secrets) &&
          tokenAuth?.isExternalIdp &&
          tokenAuth.rawToken
        ) {
          // Fallback: propagate external IdP JWT for end-to-end JWKS pattern
          // (upstream server validates the same JWT against the IdP's JWKS)
          localHeaders.Authorization = `Bearer ${tokenAuth.rawToken}`;
        }

        mergePassthroughHeaders(localHeaders, tokenAuth?.passthroughHeaders);

        return new StreamableHTTPClientTransport(new URL(endpointUrl), {
          sessionId,
          requestInit: { headers: new Headers(localHeaders) },
        });
      }

      if (catalogItem.serverType === "remote") {
        if (!catalogItem.serverUrl) {
          throw new Error("Remote server missing serverUrl");
        }

        const headers = buildStaticCredentialHeaders({
          catalogItem,
          secrets,
        });
        if (enterpriseTransportCredential) {
          headers[enterpriseTransportCredential.headerName] =
            enterpriseTransportCredential.headerValue;
        } else if (
          !hasStaticAuthorizationCredential(secrets) &&
          tokenAuth?.isExternalIdp &&
          tokenAuth.rawToken
        ) {
          // Fallback: propagate external IdP JWT for end-to-end JWKS pattern
          // (upstream server validates the same JWT against the IdP's JWKS)
          headers.Authorization = `Bearer ${tokenAuth.rawToken}`;
        }

        mergePassthroughHeaders(headers, tokenAuth?.passthroughHeaders);

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
      if (enterpriseTransportCredential) {
        throw new Error(
          "Enterprise-managed credentials require an HTTP-based MCP transport. Stdio transport is not supported.",
        );
      }

      // Stdio transport - use K8s attach!
      // Use getOrLoadDeployment to handle multi-replica scenarios where the deployment
      // may have been created by a different replica
      const k8sDeployment =
        await McpServerRuntimeManager.getOrLoadDeployment(targetMcpServerId);
      if (!k8sDeployment) {
        throw new McpServerNotReadyError(
          "MCP server is not running yet. Start or restart it, then try inspecting it again.",
        );
      }

      const podName = await k8sDeployment.getRunningPodName();
      if (!podName) {
        throw new McpServerNotReadyError(
          "MCP server is not running yet. Start or restart it, then try inspecting it again.",
        );
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

  private async resolveSecretsForTransport(params: {
    catalogItem: InternalMcpCatalog;
    secrets: Record<string, unknown>;
    secretId?: string;
  }): Promise<Record<string, unknown>> {
    if (!usesOAuthClientCredentials(params.catalogItem)) {
      return params.secrets;
    }

    if (hasUsableClientCredentialsToken(params.secrets)) {
      return params.secrets;
    }

    const oauthConfig = params.catalogItem.oauthConfig;
    if (!oauthConfig) {
      throw new Error(
        "OAuth client credentials configuration is missing oauthConfig",
      );
    }
    const clientId =
      getOptionalSecretString(params.secrets, "client_id") ||
      oauthConfig.client_id;
    const clientSecret =
      getOptionalSecretString(params.secrets, "client_secret") ||
      oauthConfig.client_secret;
    const audience =
      getOptionalSecretString(params.secrets, "audience") ||
      oauthConfig.audience;

    if (!clientId || !clientSecret) {
      throw new Error(
        "OAuth client credentials configuration requires client_id and client_secret",
      );
    }

    const cacheKey =
      params.secretId ||
      [
        params.catalogItem.id,
        clientId,
        audience,
        oauthConfig.token_endpoint || oauthConfig.auth_server_url || "",
      ].join(":");
    const existingLock = this.clientCredentialsLocks.get(cacheKey);
    if (existingLock) {
      return await existingLock;
    }

    const resolutionPromise = this.fetchClientCredentialsAccessToken({
      catalogItem: params.catalogItem,
      existingSecrets: params.secrets,
      secretId: params.secretId,
      clientId,
      clientSecret,
      audience,
    }).finally(() => {
      this.clientCredentialsLocks.delete(cacheKey);
    });

    this.clientCredentialsLocks.set(cacheKey, resolutionPromise);
    return await resolutionPromise;
  }

  private async fetchClientCredentialsAccessToken(params: {
    catalogItem: InternalMcpCatalog;
    existingSecrets: Record<string, unknown>;
    secretId?: string;
    clientId: string;
    clientSecret: string;
    audience?: string;
  }): Promise<Record<string, unknown>> {
    const oauthConfig = params.catalogItem.oauthConfig;
    if (!oauthConfig) {
      throw new Error(
        "OAuth client credentials configuration is missing oauthConfig",
      );
    }
    let tokenEndpoint = oauthConfig.token_endpoint;
    if (!tokenEndpoint) {
      const endpoints = await discoverOAuthEndpoints(oauthConfig);
      tokenEndpoint = endpoints.tokenEndpoint;
    }

    const configuredScopes =
      oauthConfig.scopes.length > 0
        ? oauthConfig.scopes
        : oauthConfig.default_scopes;
    const requestBody: Record<string, string> = {
      grant_type: "client_credentials",
      client_id: params.clientId,
      client_secret: params.clientSecret,
    };
    if (params.audience) {
      requestBody.audience = params.audience;
    }
    if (configuredScopes.length > 0) {
      requestBody.scope = configuredScopes.join(" ");
    }

    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(requestBody),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(
        `Client credentials token request to ${tokenEndpoint} failed: ${tokenResponse.status} ${errorText}`,
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!tokenData.access_token) {
      throw new Error(
        "Client credentials token response did not include access_token",
      );
    }

    const timing = buildClientCredentialsTokenTiming(
      tokenData.access_token,
      tokenData.expires_in,
    );
    const resolvedSecrets = {
      ...params.existingSecrets,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      ...(params.audience ? { audience: params.audience } : {}),
      access_token: tokenData.access_token,
      ...(timing.expiresAt
        ? { client_credentials_expires_at: timing.expiresAt }
        : {}),
      client_credentials_refresh_at: timing.refreshAt,
    };

    if (params.secretId) {
      await secretManager().updateSecret(params.secretId, resolvedSecrets);
    }

    return resolvedSecrets;
  }

  private async getTransport(
    catalogItem: InternalMcpCatalog,
    targetMcpServerId: string,
    secrets: Record<string, unknown>,
    secretId?: string,
    connectionKey?: string,
    tokenAuth?: TokenAuthContext,
    enterpriseTransportCredential?: {
      headerName: string;
      headerValue: string;
    },
  ): Promise<Transport> {
    const resolvedSecrets = await this.resolveSecretsForTransport({
      catalogItem,
      secrets,
      secretId,
    });
    if (resolvedSecrets !== secrets) {
      this.secretsCache.set(targetMcpServerId, {
        secrets: resolvedSecrets,
        ...(secretId ? { secretId } : {}),
      });
    }
    const transportKind = await this.getTransportKind(
      catalogItem,
      targetMcpServerId,
    );
    return this.getTransportWithKind(
      catalogItem,
      targetMcpServerId,
      resolvedSecrets,
      transportKind,
      connectionKey,
      tokenAuth,
      enterpriseTransportCredential,
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
    structuredError?: McpToolError,
  ): Promise<CommonToolResult> {
    const normalizedError: McpToolError = structuredError ?? {
      type: "generic",
      message: error,
    };

    const errorResult: CommonToolResult = {
      id: toolCall.id,
      name: toolCall.name,
      content: [{ type: "text", text: error }],
      isError: true,
      error,
      _meta: {
        archestraError: normalizedError,
      },
      structuredContent: {
        archestraError: normalizedError,
      },
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
  private async createSuccessResult(opts: {
    toolCall: CommonToolCall;
    agentId: string;
    mcpServerName: string;
    content: ContentBlock[];
    isError: boolean;
    _meta?: Record<string, unknown>;
    authInfo?: { userId?: string; authMethod?: MCPGatewayAuthMethod };
    structuredContent?: Record<string, unknown>;
  }): Promise<CommonToolResult> {
    const {
      toolCall,
      agentId,
      mcpServerName,
      content,
      isError,
      _meta,
      authInfo,
      structuredContent,
    } = opts;

    const toolResult: CommonToolResult = {
      id: toolCall.id,
      name: toolCall.name,
      content,
      isError,
      _meta,
      structuredContent,
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
    tokenAuth?: TokenAuthContext;
    toolCatalogId: string | null;
    toolCatalogName: string | null;
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
      tokenAuth,
      toolCatalogId,
      toolCatalogName,
      executeRetry,
    } = params;

    logger.info(
      { toolName: toolCall.name, secretId, catalogId },
      "attemptTokenRefreshAndRetry: authentication error detected, attempting token refresh and retry",
    );

    // Attempt refresh, deduplicated per secret so concurrent callers do not
    // race a rotating refresh token or thrash connection teardown state.
    const refreshResult = await this.refreshOAuthTokenWithLock({
      secretId,
      catalogId,
      connectionKey,
      targetMcpServerId,
    });

    if (!refreshResult.refreshed) {
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
      const updatedSecret = refreshResult.updatedSecret;
      if (!updatedSecret) {
        logger.warn(
          { toolName: toolCall.name, secretId },
          "attemptTokenRefreshAndRetry: failed to fetch updated secret after refresh",
        );
        return null;
      }

      // Create new transport with updated secrets
      const getUpdatedTransport = () =>
        this.getTransport(
          catalogItem,
          targetMcpServerId,
          updatedSecret,
          secretId,
        );

      return await executeRetry(getUpdatedTransport, updatedSecret);
    } catch (retryError) {
      const retryErrorMsg =
        retryError instanceof Error ? retryError.message : String(retryError);
      logger.error(
        { toolName: toolCall.name, error: retryErrorMsg },
        "attemptTokenRefreshAndRetry: retry after token refresh also failed",
      );

      // Check if retry also failed with auth error - return actionable message
      const isRetryAuthError =
        retryError instanceof UnauthorizedError ||
        (retryError instanceof StreamableHTTPError &&
          (retryError as StreamableHTTPError).code === 401) ||
        isAuthRelatedError(retryErrorMsg);

      if (isRetryAuthError && toolCatalogId) {
        const catalogDisplayName = toolCatalogName || toolCatalogId;
        const authError = this.buildExpiredAuthMessage(
          catalogDisplayName,
          toolCatalogId,
          targetMcpServerId,
          tokenAuth,
        );
        return await this.createErrorResult(
          toolCall,
          agentId,
          authError.message,
          mcpServerName,
          undefined,
          authError,
        );
      }

      return await this.createErrorResult(
        toolCall,
        agentId,
        retryErrorMsg,
        mcpServerName,
      );
    }
  }

  private async refreshOAuthTokenWithLock(params: {
    secretId: string;
    catalogId: string;
    connectionKey: string;
    targetMcpServerId: string;
  }): Promise<{
    refreshed: boolean;
    updatedSecret: Record<string, unknown> | null;
  }> {
    const { secretId, catalogId, connectionKey, targetMcpServerId } = params;
    const existingRefresh = this.oauthRefreshLocks.get(secretId);
    if (existingRefresh) {
      logger.info(
        { secretId, catalogId },
        "Waiting for concurrent OAuth token refresh",
      );
      return existingRefresh;
    }

    const refreshPromise = (async () => {
      const existingClient = this.activeConnections.get(connectionKey);
      if (existingClient) {
        try {
          await existingClient.close();
        } catch {
          // Ignore close errors during refresh teardown.
        }
        this.activeConnections.delete(connectionKey);
        this.activeConnectionServerState.delete(connectionKey);
        this.pendingHttpSessionMetadata.delete(connectionKey);
      }

      const refreshed = await refreshOAuthToken(secretId, catalogId);
      if (!refreshed) {
        return { refreshed: false, updatedSecret: null };
      }

      const updatedSecret = await secretManager().getSecret(secretId);
      if (!updatedSecret?.secret) {
        logger.warn(
          { secretId, catalogId },
          "OAuth token refresh succeeded but updated secret could not be loaded",
        );
        return { refreshed: false, updatedSecret: null };
      }

      this.secretsCache.set(targetMcpServerId, {
        secrets: updatedSecret.secret,
        secretId,
      });

      return { refreshed: true, updatedSecret: updatedSecret.secret };
    })()
      .catch((error) => {
        logger.error(
          { secretId, catalogId, error },
          "OAuth token refresh lock encountered an unexpected error",
        );
        return { refreshed: false, updatedSecret: null };
      })
      .finally(() => {
        this.oauthRefreshLocks.delete(secretId);
      });

    this.oauthRefreshLocks.set(secretId, refreshPromise);
    return refreshPromise;
  }

  /**
   * Build an actionable authentication error message with a link to the MCP registry
   * for the user to set up credentials.
   */
  private buildAuthRequiredMessage(
    catalogDisplayName: string,
    catalogId: string,
    tokenAuth?: TokenAuthContext,
  ): AuthRequiredMcpToolError {
    const context = this.formatAuthContext(tokenAuth);
    const installUrl = `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_INSTALL_QUERY_PARAM}=${catalogId}`;
    return {
      type: "auth_required",
      message: formatActionableAuthError({
        title: `Authentication required for "${catalogDisplayName}"`,
        detail: `No credentials were found for your account (${context}).`,
        actionLabel: "set up your credentials",
        url: installUrl,
        postAction:
          "Once you have completed authentication, retry this tool call.",
      }),
      catalogId,
      catalogName: catalogDisplayName,
      action: "install_mcp_credentials",
      actionUrl: installUrl,
    };
  }

  /**
   * Build an actionable error message for expired or invalid credentials,
   * with a deep link to the re-authentication dialog.
   */
  private buildExpiredAuthMessage(
    catalogDisplayName: string,
    catalogId: string,
    mcpServerId: string,
    tokenAuth?: TokenAuthContext,
    detailOverride?: string,
  ): AuthExpiredMcpToolError {
    const context = this.formatAuthContext(tokenAuth);
    const reauthUrl = `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_REAUTH_QUERY_PARAM}=${catalogId}&${MCP_CATALOG_SERVER_QUERY_PARAM}=${mcpServerId}`;
    return {
      type: "auth_expired",
      message: formatActionableAuthError({
        title: `Expired or invalid authentication for "${catalogDisplayName}"`,
        detail:
          detailOverride ??
          `Your credentials (${context}) failed authentication. Please re-authenticate to continue using this tool.`,
        actionLabel: "re-authenticate",
        url: reauthUrl,
        postAction: "Once you have re-authenticated, retry this tool call.",
      }),
      catalogId,
      catalogName: catalogDisplayName,
      serverId: mcpServerId,
      reauthUrl,
    };
  }

  private buildAssignedCredentialUnavailableMessage(
    catalogDisplayName: string,
    catalogId: string,
  ): AssignedCredentialUnavailableMcpToolError {
    return {
      type: "assigned_credential_unavailable",
      message: [
        `Expired / Invalid Authentication: credentials for "${catalogDisplayName}" have expired or are invalid.`,
        "Re-authenticate to continue using this tool.",
        "Ask the agent owner or an admin to re-authenticate.",
      ].join("\n"),
      catalogId,
      catalogName: catalogDisplayName,
    };
  }

  private async buildEnterpriseManagedIdentityProviderAuthMessage(
    catalogDisplayName: string,
    catalogId: string,
    identityProviderId: string | null,
    tokenAuth?: TokenAuthContext,
    options?: {
      conversationId?: string;
      identityProviderRedirectPath?: string;
    },
  ): Promise<AuthRequiredMcpToolError> {
    const identityProvider = identityProviderId
      ? await findExternalIdentityProviderById(identityProviderId)
      : null;
    if (!identityProvider) {
      return this.buildAuthRequiredMessage(
        catalogDisplayName,
        catalogId,
        tokenAuth,
      );
    }

    const connectUrl = this.buildIdentityProviderConnectUrl(
      identityProvider.providerId,
      options,
    );
    return {
      type: "auth_required",
      message: formatActionableAuthError({
        title: `Authentication required for "${catalogDisplayName}"`,
        detail: `This tool needs a current ${identityProvider.providerId} session for your account before this deployment can request the downstream credential.`,
        actionLabel: `connect ${identityProvider.providerId}`,
        url: connectUrl,
        postAction:
          "Once you have completed authentication, retry this tool call.",
      }),
      catalogId,
      catalogName: catalogDisplayName,
      action: "connect_identity_provider",
      actionUrl: connectUrl,
      providerId: identityProvider.providerId,
    };
  }

  private buildIdentityProviderConnectUrl(
    providerId: string,
    options?: {
      conversationId?: string;
      identityProviderRedirectPath?: string;
    },
  ): string {
    const redirectTo = this.getIdentityProviderRedirectPath(options);
    const searchParams = new URLSearchParams({
      redirectTo,
      mode: LINKED_IDP_SSO_MODE,
    });
    return `${config.frontendBaseUrl}/auth/sso/${encodeURIComponent(providerId)}?${searchParams.toString()}`;
  }

  private getIdentityProviderRedirectPath(options?: {
    conversationId?: string;
    identityProviderRedirectPath?: string;
  }): string {
    if (
      options?.identityProviderRedirectPath?.startsWith("/") &&
      !options.identityProviderRedirectPath.startsWith("//")
    ) {
      return options.identityProviderRedirectPath;
    }

    if (options?.conversationId) {
      return `/chat/${options.conversationId}`;
    }

    return "/chat";
  }

  private formatAuthContext(tokenAuth?: TokenAuthContext): string {
    if (tokenAuth?.userId) return `user: ${tokenAuth.userId}`;
    if (tokenAuth?.teamId) return `team: ${tokenAuth.teamId}`;
    return "organization";
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
   * Race a promise against a timeout, clearing the timer when the primary
   * promise settles to prevent dangling timers under high throughput.
   */
  private raceWithTimeout<T>(
    promise: Promise<T>,
    ms: number,
    errorOrMessage: string | Error,
  ): Promise<T> {
    let timerId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(
          typeof errorOrMessage === "string"
            ? new Error(errorOrMessage)
            : errorOrMessage,
        );
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() =>
      clearTimeout(timerId),
    );
  }

  /**
   * Connect to an MCP server and return available tools
   */
  async connectAndGetTools(params: {
    catalogItem: InternalMcpCatalog;
    mcpServerId: string;
    secrets: Record<string, unknown>;
    secretId?: string;
  }): Promise<CommonMcpToolDefinition[]> {
    const { catalogItem, mcpServerId, secrets, secretId } = params;

    // Local stdio servers can report a ready pod before the MCP process accepts
    // JSON-RPC, especially while the runtime is still pulling or starting Node.
    const maxRetries = catalogItem.serverType === "local" ? 6 : 1;
    const retryDelayMs = 5000; // 5 seconds between retries

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get the appropriate transport using the existing helper
        const transport = await this.getTransport(
          catalogItem,
          mcpServerId,
          secrets,
          secretId,
        );

        const capabilities: ClientCapabilitiesWithExtensions = {
          roots: { listChanged: true },
          extensions: MCP_CLIENT_EXTENSION_CAPABILITIES,
        };

        // Create client with transport
        const client = new Client(buildMcpClientInfo("archestra-platform"), {
          capabilities,
        });

        // Connect with timeout
        await this.raceWithTimeout(
          client.connect(transport),
          30000,
          "Connection timeout after 30 seconds",
        );

        // List tools with timeout. Some MCP servers expose only resources; for
        // those, synthesize read-resource tools so agents can still exercise the
        // server through the normal tool-assignment path.
        const tools = await this.discoverToolsOrResourceTools(client);

        // Close connection (we just needed the tools)
        await client.close();

        // Transform tools to our format
        return tools.map((tool: Tool) => ({
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          _meta: tool._meta,
          annotations: tool.annotations,
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

  private async discoverToolsOrResourceTools(client: Client): Promise<Tool[]> {
    try {
      const toolsResult = await this.raceWithTimeout(
        client.listTools(),
        30000,
        "List tools timeout after 30 seconds",
      );
      return toolsResult.tools;
    } catch (error) {
      if (!isMethodNotFoundError(error)) {
        throw error;
      }

      const resourcesResult = await this.raceWithTimeout(
        client.listResources(),
        30000,
        "List resources timeout after 30 seconds",
      );

      return resourcesResult.resources.map((resource) => {
        const uri = resource.uri;
        const displayName = resource.name ?? resource.uri;
        return {
          name: makeSyntheticResourceToolName(uri),
          description:
            resource.description ?? `Read MCP resource ${displayName}`,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          _meta: {
            archestraResourceUri: uri,
          },
        };
      }) as Tool[];
    }
  }

  /**
   * Connect to a running MCP server and list tools or call a tool.
   */
  async inspectServer(params: {
    catalogItem: InternalMcpCatalog;
    mcpServerId: string;
    secrets: Record<string, unknown>;
    method: "tools/list" | "tools/call";
    toolName?: string;
    toolArguments?: Record<string, unknown>;
  }): Promise<unknown> {
    const { catalogItem, mcpServerId, secrets, method } = params;

    const transport = await this.getTransport(
      catalogItem,
      mcpServerId,
      secrets,
      undefined,
    );

    const client = new Client(buildMcpClientInfo("archestra-inspector"), {
      capabilities: {},
    });

    try {
      await this.raceWithTimeout(
        client.connect(transport),
        30000,
        new McpServerConnectionTimeoutError(),
      );

      if (method === "tools/list") {
        return await this.raceWithTimeout(
          client.listTools(),
          30000,
          "List tools timeout",
        );
      }

      if (!params.toolName) {
        throw new Error("toolName is required for tools/call");
      }
      return await this.raceWithTimeout(
        client.callTool({
          name: params.toolName,
          arguments: params.toolArguments ?? {},
        }),
        60000,
        "Tool call timeout",
      );
    } finally {
      await client.close().catch(() => {});
    }
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
      this.activeConnections.keys(),
    ).map(async (connectionKey) => {
      const client = this.activeConnections.get(connectionKey);
      if (!client) {
        return;
      }

      try {
        await client.close();
      } catch (error) {
        logger.error({ err: error }, "Error closing active MCP connection:");
      }
    });

    await Promise.all([...disconnectPromises, ...activeDisconnectPromises]);
    this.activeConnections.clear();
    this.activeConnectionServerState.clear();
    this.pendingHttpSessionMetadata.clear();
  }

  async invalidateConnectionsForServer(
    targetMcpServerId: string,
  ): Promise<void> {
    const matchingConnectionKeys = Array.from(
      this.activeConnections.keys(),
    ).filter((connectionKey) => {
      const parts = connectionKey.split(":");
      return parts[1] === targetMcpServerId;
    });

    await Promise.all(
      matchingConnectionKeys.map(async (connectionKey) => {
        const client = this.activeConnections.get(connectionKey);
        if (client) {
          try {
            await client.close();
          } catch (error) {
            logger.warn(
              { connectionKey, targetMcpServerId, error },
              "Error closing active MCP connection during server invalidation",
            );
          }
        }

        this.activeConnections.delete(connectionKey);
        this.activeConnectionServerState.delete(connectionKey);
        this.toolNameCache.delete(connectionKey);
        this.pendingHttpSessionMetadata.delete(connectionKey);
        await McpHttpSessionModel.deleteStaleSession(connectionKey).catch(
          (error) => {
            logger.warn(
              { connectionKey, targetMcpServerId, error },
              "Failed to delete stale MCP HTTP session during server invalidation",
            );
          },
        );
      }),
    );

    const matchingSecretKeys = Array.from(this.secretsCache.keys()).filter(
      (cacheKey) => cacheKey === targetMcpServerId,
    );
    for (const cacheKey of matchingSecretKeys) {
      this.secretsCache.delete(cacheKey);
    }
  }

  /**
   * Read a resource from its assigned MCP server
   */
  async readResource(
    uri: string,
    agentId: string,
    tokenAuth?: TokenAuthContext,
  ): Promise<ResourceContents> {
    // Include userId in cache key so per-user OAuth sessions are never mixed.
    const userScope = tokenAuth?.userId ?? "anonymous";
    const cacheKey = `${agentId}:${userScope}:${uri}`;
    const now = Date.now();

    const cached = this.resourceCache.get(cacheKey);
    if (cached && cached.ttl > now) {
      logger.debug(
        { uri, agentId, cached: true },
        "readResource: Cache hit, returning cached result",
      );
      this.refreshResourceInBackground(
        uri,
        agentId,
        tokenAuth,
        cacheKey,
        cached.result,
      ).catch((err) =>
        logger.warn(
          { err, uri, agentId },
          "readResource: Background refresh failed",
        ),
      );
      return cached.result;
    }

    const staleCache = cached;

    logger.info(
      { uri, agentId, hasStaleCache: !!staleCache },
      "readResource: Starting resource read",
    );

    const mcpServer = await this.findMcpServerForResource(uri, agentId);

    if (!mcpServer) {
      logger.error(
        { uri, agentId },
        "readResource: No server could be found for resource",
      );
      if (staleCache) {
        logger.info(
          { uri, agentId },
          "readResource: Returning stale cache due to no server found",
        );
        return staleCache.result;
      }
      throw new Error(`Resource not found or no server could read it: ${uri}`);
    }

    try {
      const result = await this.doReadResource(
        uri,
        agentId,
        mcpServer,
        tokenAuth,
      );
      this.resourceCache.set(cacheKey, {
        result,
        ttl: now + RESOURCE_CACHE_TTL_MS,
      });
      logger.info(
        { uri, agentId, serverId: mcpServer.server.id },
        "readResource: Successfully read and cached resource",
      );
      return result;
    } catch (error) {
      if (staleCache) {
        logger.warn(
          { uri, agentId, error },
          "readResource: Refresh failed, returning stale cache",
        );
        return staleCache.result;
      }
      throw error;
    }
  }

  private async findMcpServerForResource(
    uri: string,
    agentId: string,
  ): Promise<{
    server: NonNullable<Awaited<ReturnType<typeof McpServerModel.findById>>>;
    catalogItem: NonNullable<
      Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>
    >;
  } | null> {
    const matchingTools = await ToolModel.findToolsByUiResourceUri(
      agentId,
      uri,
    );

    if (matchingTools.length > 0 && matchingTools[0].catalogId) {
      const catalogId = matchingTools[0].catalogId;
      const catalogItem = await InternalMcpCatalogModel.findById(catalogId);
      if (catalogItem) {
        const servers = await McpServerModel.findByCatalogId(catalogId);
        const server = servers[0];
        if (server) {
          logger.info(
            { uri, agentId, serverId: server.id, serverName: catalogItem.name },
            "readResource: Found server via tool meta (fast lookup)",
          );
          return { server, catalogItem };
        }
      }
    }

    logger.warn(
      { uri, agentId },
      "readResource: No tool found with matching ui/resourceUri in meta",
    );
    return null;
  }

  private async doReadResource(
    uri: string,
    agentId: string,
    mcpServer: {
      server: NonNullable<Awaited<ReturnType<typeof McpServerModel.findById>>>;
      catalogItem: NonNullable<
        Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>
      >;
    },
    tokenAuth?: TokenAuthContext,
  ): Promise<ResourceContents> {
    const { server, catalogItem } = mcpServer;

    const secretResult = await this.getSecretsForMcpServer({
      targetMcpServerId: server.id,
      toolCall: { id: "resource-read", name: "read", arguments: {} },
      agentId,
    });

    if ("error" in secretResult) {
      throw new Error(`Secret resolution failed: ${secretResult.error}`);
    }
    const { secrets, secretId } = secretResult;

    const transport = await this.getTransport(
      catalogItem,
      server.id,
      secrets,
      secretId,
      undefined,
      tokenAuth,
    );
    const connectionKey = `${catalogItem.id}:${server.id}:${agentId}`;
    const client = await this.getOrCreateClient(
      connectionKey,
      transport,
      server.id,
      secretResult.serverState,
    );

    const result = await client.readResource({ uri });
    return result;
  }

  private async refreshResourceInBackground(
    uri: string,
    agentId: string,
    _tokenAuth: TokenAuthContext | undefined,
    cacheKey: string,
    _currentResult: ResourceContents,
  ): Promise<void> {
    try {
      const mcpServer = await this.findMcpServerForResource(uri, agentId);
      if (!mcpServer) {
        logger.debug(
          { uri, agentId },
          "readResource: Background refresh - no server found",
        );
        return;
      }

      const newResult = await this.doReadResource(
        uri,
        agentId,
        mcpServer,
        _tokenAuth,
      );
      this.resourceCache.set(cacheKey, {
        result: newResult,
        ttl: Date.now() + RESOURCE_CACHE_TTL_MS,
      });
      logger.debug(
        { uri, agentId },
        "readResource: Background refresh succeeded",
      );
    } catch (error) {
      logger.warn(
        { uri, agentId, error },
        "readResource: Background refresh failed, keeping old data",
      );
    }
  }

  /**
   * Get connected MCP SDK clients for all upstream servers of an agent.
   * Returns one client per distinct catalog item (MCP server installation).
   */
  private async getClientsForAgent(agentId: string): Promise<Client[]> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);

    // Collect distinct catalog IDs (skip Archestra built-in tools which have no upstream server)
    const catalogIds = [
      ...new Set(
        tools.map((t) => t.catalogId).filter((id): id is string => !!id),
      ),
    ];

    const clients: Client[] = [];

    for (const catalogId of catalogIds) {
      try {
        const catalogItem = await InternalMcpCatalogModel.findById(catalogId);
        if (!catalogItem) continue;

        const servers = await McpServerModel.findByCatalogId(catalogId);
        const server = servers[0];
        if (!server) continue;

        const secretResult = await this.getSecretsForMcpServer({
          targetMcpServerId: server.id,
          toolCall: { id: "list-op", name: "list", arguments: {} },
          agentId,
        });
        if ("error" in secretResult) continue;

        const transport = await this.getTransport(
          catalogItem,
          server.id,
          secretResult.secrets,
          secretResult.secretId,
        );
        const connectionKey = `${catalogItem.id}:${server.id}`;
        const client = await this.getOrCreateClient(
          connectionKey,
          transport,
          server.id,
          secretResult.serverState,
        );
        clients.push(client);
      } catch (error) {
        logger.warn(
          { agentId, catalogId, error },
          "getClientsForAgent: failed to connect to upstream server, skipping",
        );
      }
    }

    return clients;
  }

  /**
   * List resources from all upstream MCP servers connected to an agent.
   */
  async listResources(
    agentId: string,
  ): Promise<{ resources: Array<Record<string, unknown>> }> {
    const clients = await this.getClientsForAgent(agentId);
    const allResources: Array<Record<string, unknown>> = [];

    await Promise.all(
      clients.map(async (client) => {
        try {
          const result = await client.listResources();
          allResources.push(
            ...(result.resources as unknown as Array<Record<string, unknown>>),
          );
        } catch (error) {
          logger.warn(
            { error },
            "listResources: upstream server failed, skipping",
          );
        }
      }),
    );

    return { resources: allResources };
  }

  /**
   * List resource templates from all upstream MCP servers connected to an agent.
   */
  async listResourceTemplates(
    agentId: string,
  ): Promise<{ resourceTemplates: Array<Record<string, unknown>> }> {
    const clients = await this.getClientsForAgent(agentId);
    const allTemplates: Array<Record<string, unknown>> = [];

    await Promise.all(
      clients.map(async (client) => {
        try {
          const result = await client.listResourceTemplates();
          allTemplates.push(
            ...(result.resourceTemplates as unknown as Array<
              Record<string, unknown>
            >),
          );
        } catch (error) {
          logger.warn(
            { error },
            "listResourceTemplates: upstream server failed, skipping",
          );
        }
      }),
    );

    return { resourceTemplates: allTemplates };
  }

  /**
   * List prompts from all upstream MCP servers connected to an agent.
   */
  async listPrompts(
    agentId: string,
  ): Promise<{ prompts: Array<Record<string, unknown>> }> {
    const clients = await this.getClientsForAgent(agentId);
    const allPrompts: Array<Record<string, unknown>> = [];

    await Promise.all(
      clients.map(async (client) => {
        try {
          const result = await client.listPrompts();
          allPrompts.push(
            ...(result.prompts as unknown as Array<Record<string, unknown>>),
          );
        } catch (error) {
          logger.warn(
            { error },
            "listPrompts: upstream server failed, skipping",
          );
        }
      }),
    );

    return { prompts: allPrompts };
  }

  private async resolveCachedEnterpriseTransportCredential(params: {
    agentId: string;
    tokenAuth?: TokenAuthContext;
    enterpriseManagedConfig: EnterpriseManagedCredentialConfig | null;
  }): Promise<ResolvedEnterpriseTransportCredential | null> {
    const cacheKey = this.buildEnterpriseCredentialCacheKey(params);
    if (cacheKey) {
      const cachedCredential = this.enterpriseCredentialCache.get(cacheKey);
      if (cachedCredential) {
        return cachedCredential;
      }
    }

    const credential = await resolveEnterpriseTransportCredential(params);
    if (cacheKey && credential) {
      this.enterpriseCredentialCache.set(
        cacheKey,
        credential,
        this.resolveEnterpriseCredentialCacheTtl(credential.expiresInSeconds),
      );
    }

    return credential;
  }

  private buildEnterpriseCredentialCacheKey(params: {
    agentId: string;
    tokenAuth?: TokenAuthContext;
    enterpriseManagedConfig: EnterpriseManagedCredentialConfig | null;
  }): string | null {
    if (!params.enterpriseManagedConfig || !params.tokenAuth) {
      return null;
    }

    return JSON.stringify({
      agentId: params.agentId,
      identityProviderId: params.enterpriseManagedConfig.identityProviderId,
      resourceIdentifier: params.enterpriseManagedConfig.resourceIdentifier,
      requestedIssuer: params.enterpriseManagedConfig.requestedIssuer,
      requestedCredentialType:
        params.enterpriseManagedConfig.requestedCredentialType,
      tokenInjectionMode: params.enterpriseManagedConfig.tokenInjectionMode,
      headerName: params.enterpriseManagedConfig.headerName,
      responseFieldPath: params.enterpriseManagedConfig.responseFieldPath,
      audience: params.enterpriseManagedConfig.audience,
      scopes: params.enterpriseManagedConfig.scopes ?? [],
      tokenId: params.tokenAuth.tokenId,
      userId: params.tokenAuth.userId ?? null,
      teamId: params.tokenAuth.teamId,
      isOrganizationToken: params.tokenAuth.isOrganizationToken,
      isExternalIdp: params.tokenAuth.isExternalIdp ?? false,
      rawToken: params.tokenAuth.rawToken ?? null,
    });
  }

  private resolveEnterpriseCredentialCacheTtl(
    expiresInSeconds: number | null,
  ): number {
    if (expiresInSeconds && expiresInSeconds > 0) {
      return expiresInSeconds * 1000;
    }

    return McpClient.ENTERPRISE_CREDENTIAL_CACHE_FALLBACK_TTL_MS;
  }

  private hasMatchingServerState(
    left: CachedServerState,
    right: CachedServerState,
  ): boolean {
    return left.secretId === right.secretId;
  }

  private toCachedServerState(
    mcpServer: NonNullable<Awaited<ReturnType<typeof McpServerModel.findById>>>,
  ): CachedServerState {
    return {
      secretId: mcpServer.secretId ?? null,
    };
  }
}

/**
 * Check if a browser tool is high-frequency and should skip logging.
 * Screenshots (~2s interval), tab list checks, and viewport resizes
 * generate too many log entries. Other browser actions (navigate, click,
 * type, snapshot, etc.) are logged normally.
 */
/**
 * Detect auth-related errors from error messages.
 * Some MCP servers return non-401 HTTP status codes but include auth error
 * details in the response body (e.g. GitHub returns "unauthorized: AuthenticateToken
 * authentication failed"). This catches those cases.
 */
function isAuthRelatedError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("unauthorized") ||
    lower.includes("authentication failed") ||
    lower.includes("authentication required") ||
    lower.includes("invalid token") ||
    lower.includes("token expired") ||
    lower.includes("access denied") ||
    lower.includes("invalid credentials") ||
    lower.includes("credentials expired")
  );
}

function isAuthRelatedToolResult(result: {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}): boolean {
  if (!result.isError) {
    return false;
  }

  const contentText = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  const structuredText = result.structuredContent
    ? JSON.stringify(result.structuredContent)
    : "";
  const metaText = result._meta ? JSON.stringify(result._meta) : "";

  return isOAuthTokenFailureText(
    `${contentText}\n${structuredText}\n${metaText}`,
  );
}

function shouldProactivelyRefreshOAuthToken(
  secrets: Record<string, unknown>,
): boolean {
  const expiresAt = secrets.expires_at;
  if (typeof expiresAt !== "number") {
    return false;
  }

  return expiresAt <= Date.now() + OAUTH_TOKEN_REFRESH_BUFFER_MS;
}

function isOAuthTokenFailureText(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes("invalid_token") ||
    lower.includes("invalid token") ||
    lower.includes("invalid bearer token") ||
    lower.includes("token_expired") ||
    lower.includes("token expired") ||
    lower.includes("expired token") ||
    lower.includes("access token expired") ||
    lower.includes("refresh token expired") ||
    lower.includes("invalid bearer") ||
    lower.includes('bearer realm="') ||
    (lower.includes("www-authenticate") && lower.includes("bearer"))
  );
}

function isHighFrequencyBrowserTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name.includes("browser_take_screenshot") ||
    name.includes("browser_screenshot") ||
    name.includes("browser_tabs") ||
    name.includes("browser_resize")
  );
}

function getSyntheticResourceToolUri(
  meta: Record<string, unknown> | null | undefined,
): string | null {
  const nestedMeta = meta?._meta;
  if (!nestedMeta || typeof nestedMeta !== "object") {
    return null;
  }

  const resourceUri = (nestedMeta as Record<string, unknown>)
    .archestraResourceUri;
  return typeof resourceUri === "string" && resourceUri.length > 0
    ? resourceUri
    : null;
}

function makeSyntheticResourceToolName(uri: string): string {
  const slug = uri
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `read_resource_${slug || "resource"}`.slice(0, 128);
}

function isMethodNotFoundError(error: unknown): boolean {
  if (error instanceof Error && error.message.includes("Method not found")) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === -32601
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

/**
 * Format an actionable auth error message that strongly encourages the LLM
 * to display the URL to the user. The wording is intentionally directive
 * so that models reliably surface the link rather than paraphrasing it away.
 */
function formatActionableAuthError(params: {
  title: string;
  detail: string;
  actionLabel: string;
  url: string;
  postAction: string;
}): string {
  return [
    `${params.title}.`,
    "",
    params.detail,
    `To ${params.actionLabel}, visit this URL: ${params.url}`,
    "",
    "IMPORTANT: You MUST display the URL above to the user exactly as shown. Do NOT omit it or paraphrase it.",
    "",
    params.postAction,
  ].join("\n");
}

/** Merge passthrough headers into target, skipping keys already present (case-insensitive). */
function mergePassthroughHeaders(
  target: Record<string, string>,
  passthrough: Record<string, string> | undefined,
): void {
  if (!passthrough) return;
  const existing = new Set(Object.keys(target).map((k) => k.toLowerCase()));
  for (const [name, value] of Object.entries(passthrough)) {
    if (!existing.has(name.toLowerCase())) {
      target[name] = value;
    }
  }
}

function buildStaticCredentialHeaders(params: {
  catalogItem: InternalMcpCatalog;
  secrets: Record<string, unknown>;
}): Record<string, string> {
  const { catalogItem, secrets } = params;
  const headers: Record<string, string> = {};
  const tokenFieldUsesExplicitHeader = Boolean(
    catalogItem.userConfig?.access_token?.headerName ||
      catalogItem.userConfig?.raw_access_token?.headerName,
  );

  if (!catalogItem.userConfig) {
    return buildDefaultAuthorizationHeaders(headers, secrets);
  }

  for (const [fieldName, config] of Object.entries(catalogItem.userConfig)) {
    if (!config.headerName) {
      continue;
    }

    const secretValue = secrets[fieldName];
    if (typeof secretValue !== "string" || secretValue.length === 0) {
      continue;
    }

    headers[config.headerName] = getStaticCredentialHeaderValue({
      fieldName,
      headerName: config.headerName,
      secretValue,
      valuePrefix: config.valuePrefix,
    });
  }

  if (tokenFieldUsesExplicitHeader) {
    return headers;
  }

  return buildDefaultAuthorizationHeaders(headers, secrets);
}

function usesOAuthClientCredentials(catalogItem: InternalMcpCatalog): boolean {
  return catalogItem.oauthConfig?.grant_type === "client_credentials";
}

function getOptionalSecretString(
  secrets: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = secrets[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasUsableClientCredentialsToken(
  secrets: Record<string, unknown>,
): boolean {
  const accessToken = getOptionalSecretString(secrets, "access_token");
  if (!accessToken) {
    return false;
  }

  const refreshAt = toOptionalTimestamp(secrets.client_credentials_refresh_at);
  if (refreshAt) {
    return Date.now() < refreshAt;
  }

  const expiresAt = toOptionalTimestamp(secrets.client_credentials_expires_at);
  if (expiresAt) {
    return Date.now() + TimeInMs.Minute < expiresAt;
  }

  return false;
}

function buildClientCredentialsTokenTiming(
  accessToken: string,
  expiresIn?: number,
): {
  expiresAt?: number;
  refreshAt: number;
} {
  const now = Date.now();
  const jwtExpiration = getJwtExpirationMs(accessToken);
  if (jwtExpiration && jwtExpiration > now) {
    const lifetimeMs = jwtExpiration - now;
    return {
      expiresAt: jwtExpiration,
      refreshAt: now + Math.max(lifetimeMs / 2, TimeInMs.Minute),
    };
  }

  if (
    typeof expiresIn === "number" &&
    Number.isFinite(expiresIn) &&
    expiresIn > 0
  ) {
    const lifetimeMs = expiresIn * 1000;
    return {
      expiresAt: now + lifetimeMs,
      refreshAt: now + Math.max(lifetimeMs / 2, TimeInMs.Minute),
    };
  }

  return {
    refreshAt: now + CLIENT_CREDENTIALS_FALLBACK_TTL_MS,
  };
}

function toOptionalTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return undefined;
}

function getJwtExpirationMs(token: string): number | undefined {
  const [, payload] = token.split(".");
  if (!payload) {
    return undefined;
  }

  try {
    const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const paddedPayload =
      normalizedPayload + "=".repeat((4 - (normalizedPayload.length % 4)) % 4);
    const decoded = JSON.parse(
      Buffer.from(paddedPayload, "base64").toString("utf8"),
    ) as { exp?: number };
    if (
      typeof decoded.exp === "number" &&
      Number.isFinite(decoded.exp) &&
      decoded.exp > 0
    ) {
      return decoded.exp * 1000;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function hasStaticAuthorizationCredential(
  secrets: Record<string, unknown>,
): boolean {
  if (
    typeof secrets.access_token === "string" &&
    secrets.access_token.length > 0
  ) {
    return true;
  }

  if (
    typeof secrets.raw_access_token === "string" &&
    secrets.raw_access_token.length > 0
  ) {
    return true;
  }

  return false;
}

function getStaticCredentialHeaderValue(params: {
  fieldName: string;
  headerName: string;
  secretValue: string;
  valuePrefix?: string;
}): string {
  if (params.valuePrefix) {
    return `${params.valuePrefix}${params.secretValue}`;
  }

  if (
    params.fieldName === "access_token" &&
    params.headerName.toLowerCase() === "authorization"
  ) {
    return `Bearer ${params.secretValue}`;
  }

  return params.secretValue;
}

function buildDefaultAuthorizationHeaders(
  headers: Record<string, string>,
  secrets: Record<string, unknown>,
): Record<string, string> {
  const hasAuthorizationHeader = Object.keys(headers).some(
    (headerName) => headerName.toLowerCase() === "authorization",
  );

  if (typeof secrets.access_token === "string" && !hasAuthorizationHeader) {
    headers.Authorization = `Bearer ${secrets.access_token}`;
  } else if (
    typeof secrets.raw_access_token === "string" &&
    !hasAuthorizationHeader
  ) {
    headers.Authorization = String(secrets.raw_access_token);
  }

  return headers;
}
