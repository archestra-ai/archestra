import { createHash, randomUUID } from "node:crypto";
import {
  type AssignedCredentialUnavailableMcpToolError,
  type AuthExpiredMcpToolError,
  type AuthRequiredMcpToolError,
  getArchestraAppResourceUri,
  LINKED_IDP_SSO_MODE,
  LOCKED_CHAT_REDACTED_MARKER,
  MCP_APPS_CLIENT_EXTENSION_CAPABILITIES,
  MCP_CATALOG_INSTALL_PATH,
  MCP_CATALOG_INSTALL_QUERY_PARAM,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
  MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
  MCP_EXECUTED_AS_META_KEY,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  MCP_SKILLS_CLIENT_EXTENSION_CAPABILITIES,
  MCP_SKILLS_EXTENSION_ID,
  type McpExecutedAs,
  type McpToolError,
  parseFullToolName,
  platformExecutedAs,
  stripReservedPlatformMeta,
  TimeInMs,
} from "@archestra/shared";
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
import QuickLRU from "quick-lru";
import { unavailableThirdPartyToolMessage } from "@/archestra-mcp-server/tool-recovery-messages";
import { getMcpCatalogPermissionChecker } from "@/auth/mcp-catalog-permissions";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import type { LockedChatAuditContext } from "@/content-encryption/locked-chat";
import {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  McpServerDeploymentFailedError,
  // SPDX-SnippetEnd
  McpServerRuntimeManager,
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  McpServerWakeError,
  McpServerWakePendingError,
  wakeResponseBudgetMs,
  withDeadline,
  // SPDX-SnippetEnd
} from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import {
  AgentModel,
  AppModel,
  InternalMcpCatalogModel,
  McpHttpSessionModel,
  McpServerAlertMuteModel,
  McpServerModel,
  McpToolCallModel,
  TeamModel,
  ToolModel,
  UserModel,
} from "@/models";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import { discoverOAuthEndpoints, refreshOAuthToken } from "@/routes/oauth";
import { secretManager } from "@/secrets-manager";
import {
  type AgentToolExclusionSets,
  agentToolExclusionsService,
  hasAnyExclusions,
  isToolIdentityExcluded,
  isToolRowExcluded,
} from "@/services/agent-tool-exclusions";
import { escapeAppNameForModelText } from "@/services/apps/app-run-link";
import { evaluateRemoteServerUrlAgainstNetworkPolicy } from "@/services/environments/remote-server-network-policy";
import {
  type ResolvedEnterpriseTransportCredential,
  resolveEnterpriseTransportCredential,
} from "@/services/identity-providers/enterprise-managed/broker";
import { findExternalIdentityProviderById } from "@/services/identity-providers/oidc";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// biome-ignore lint/style/noRestrictedImports: runtime-gated EE model import
import { mcpActiveUseTracker } from "@/services/mcp-active-use.ee";
// SPDX-SnippetEnd
import {
  classifyThrownRefreshError,
  type OAuthRefreshOutcome,
  refreshFailureToServerFields,
} from "@/services/oauth-refresh-classification";
import type {
  Tool as CatalogTool,
  CommonMcpToolDefinition,
  CommonToolCall,
  CommonToolResult,
  EnterpriseManagedCredentialConfig,
  InternalMcpCatalog,
  MCPGatewayAuthMethod,
  McpServer,
  McpToolAssignment,
  ResourceVisibilityScope,
  ToolOwner,
} from "@/types";
import { agentOwner } from "@/types";
import type { ClientCapabilitiesWithExtensions } from "@/types/mcp-capabilities";
import { deriveAuthMethod } from "@/utils/auth-method";
import { buildMcpClientInfo } from "@/utils/mcp-client-info";
import {
  collectErrorCodes,
  isConnectionErrno,
  isTimeoutErrno,
} from "@/utils/network-errors";
import { previewToolResultContent } from "@/utils/tool-result-preview";
import { K8sAttachTransport } from "./k8s-attach-transport";
import {
  configureMcpElicitation,
  type McpElicitationHandler,
  withMcpElicitationCapability,
} from "./mcp-elicitation";
import { mcpParamHeadersForCall } from "./mcp-param-headers";
import {
  captureServerExtensions,
  type DirectServerSession,
} from "./mcp-server-extensions";

type PassiveMcpClient = {
  execute: <T>(operation: (client: Client) => Promise<T>) => Promise<
    | { ran: true; value: T }
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    | { ran: false }
    // SPDX-SnippetEnd
  >;
};

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// Runtime startup wires this after module initialization to avoid the
// manager -> model -> client import cycle. Both web and worker startup paths
// call it, so registration must be idempotent.
let hibernationInvalidationRegistered = false;
export function registerMcpClientHibernationInvalidation(): void {
  if (hibernationInvalidationRegistered) return;

  hibernationInvalidationRegistered = true;
  McpServerRuntimeManager.registerHibernationListener(async (mcpServerIds) => {
    for (const mcpServerId of mcpServerIds) {
      await mcpClient.invalidateConnectionsForServer(mcpServerId);
    }
  });
}
// SPDX-SnippetEnd

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
 * Thrown when connecting to (or discovering tools from) a user's MCP server
 * fails — the server is unreachable, rejects the connection, or errors during
 * the handshake. An operational/config condition on the caller's side, not a
 * bug of ours: error tracking drops it by name, and routes map it to a 502.
 */
class McpServerUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerUnreachableError";
  }
}

/**
 * Thrown when a stored HTTP session ID is no longer valid (e.g. pod restarted).
 * Caught by executeToolCallForOwner to trigger a transparent retry with a fresh session.
 */
class StaleSessionError extends Error {
  constructor(connectionKey: string) {
    super(`Stale MCP HTTP session for connection ${connectionKey}`);
    this.name = "StaleSessionError";
  }
}

/**
 * Whether a failure is the upstream rejecting our streamable-HTTP session id
 * rather than failing the operation itself.
 *
 * The MCP SDK skips the `initialize` handshake when the transport already has
 * a session id, so a session the upstream no longer knows about does not
 * surface at connect time — it surfaces on the first real RPC. The same is
 * true for a session established seconds earlier that the upstream then drops
 * (a restart, a session TTL, or a request landing on a different replica).
 *
 * Safe to retry in both cases: the upstream rejects the POST at the transport
 * layer, before the JSON-RPC message is dispatched, so nothing ran.
 */
function isStaleSessionError(error: unknown): boolean {
  return (
    error instanceof StaleSessionError ||
    (error instanceof StreamableHTTPError &&
      String(error.message).includes("Session not found"))
  );
}

const RESOURCE_READ_RETRY_MAX_ATTEMPTS = 8;
const RESOURCE_READ_RETRY_BASE_DELAY_MS = 500;
const RESOURCE_READ_RETRY_MAX_DELAY_MS = 2_000;
const RESOURCE_READ_RETRY_DEADLINE_MS = 10_000;
const TRANSIENT_RESOURCE_HTTP_STATUSES = new Set([
  408, 425, 429, 502, 503, 504,
]);

/**
 * Resource reads are idempotent, so transport failures that occur around a
 * cold start are safe to reconnect and retry. Protocol, authorization, and
 * resource errors are intentionally excluded.
 */
function isTransientResourceReadError(error: unknown): boolean {
  if (
    error instanceof McpServerWakeError ||
    isStaleSessionError(error) ||
    collectErrorCodes(error).some(
      (code) => isConnectionErrno(code) || isTimeoutErrno(code),
    )
  ) {
    return true;
  }

  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    for (const status of [
      candidate.code,
      candidate.status,
      candidate.statusCode,
    ]) {
      if (
        typeof status === "number" &&
        TRANSIENT_RESOURCE_HTTP_STATUSES.has(status)
      ) {
        return true;
      }
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\bfetch failed\b|\bconnection (?:closed|reset|refused)\b|\bsocket hang up\b/i.test(
    message,
  );
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
  /** Durable execution that issued this gateway request, when provided. */
  executionId?: string;
};

/**
 * The ownership fields of the install a tool call resolved to — everything
 * needed to say whose credential served the call.
 */
type ResolvedInstallIdentity = Pick<
  McpServer,
  "id" | "ownerId" | "teamId" | "scope"
>;

/**
 * Identity fields attached to every persisted tool call and returned result:
 * who called (inbound), how they authenticated, and — once a credential has
 * been resolved — whose credential the upstream call ran under.
 */
type ToolCallAuthInfo = {
  userId?: string;
  authMethod?: MCPGatewayAuthMethod;
  executedAs?: McpExecutedAs;
  executionId?: string;
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
const ACTIVE_CONNECTION_PING_VALIDATION_INTERVAL_MS = 30 * TimeInMs.Second;

const RESOURCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const RESOURCE_CACHE_MAX_SIZE = 1000;

type ResourceContents = { contents: ReadResourceResult["contents"] };

type CachedResource = {
  result: ResourceContents;
  ttl: number;
};

type CachedServerState = {
  secretId: string | null;
  credentialFingerprint: string | null;
};

/** Options for {@link McpClient.executeToolCallForOwner}. */
interface ExecuteToolCallForOwnerOptions {
  conversationId?: string;
  identityProviderRedirectPath?: string;
  elicitationHandler?: McpElicitationHandler;
  /**
   * Cancels the in-flight upstream request (callTool / listTools /
   * readResource) when the caller's chat run is stopped. Without it a slow
   * tool call runs to completion after Stop; see executeToolCall's catch,
   * which rethrows an aborted call instead of retrying it.
   */
  abortSignal?: AbortSignal;
  /**
   * Overrides the default upstream tool-call timeout. Set by the gateway
   * for task-eligible calls, whose bound is the task TTL rather than the
   * synchronous patience window.
   */
  upstreamTimeoutMs?: number;
  /**
   * Pre-resolved catalog tool row for dynamic tool access: lets run_tool
   * execute a tool the agent was never assigned. This governs tool ACCESS
   * only. Whose credential/connection the call uses is still decided by
   * the MCP server's connection policy (on-behalf-of the caller, or a
   * pinned service account) — identical to an assigned tool. An
   * unassigned tool has no assignment row, so it resolves its connection
   * at call time (it can't carry a static pin). Access authorization
   * happens at the dispatch layer (archestra-mcp-server/dynamic-tools.ts)
   * before this is set; the gateway path never sets it.
   */
  availableTool?: CatalogTool;
  /**
   * Locked chat conversation: the persisted mcp_tool_calls row keeps the
   * tool name but never stores plaintext arguments or result content.
   */
  suppressContentLogging?: boolean;
  /**
   * Present only for a locked chat that has an escrow record: the
   * row's content is encrypted under the conversation key instead of being
   * thrown away. Without it a suppressed call falls back to redaction.
   */
  lockedChatAudit?: LockedChatAuditContext | null;
}

/**
 * How one call's persisted `mcp_tool_calls` row must handle content, resolved
 * once from the caller's options and threaded down every persist path.
 * `undefined` means "not a locked-chat call, store normally".
 *
 * Deliberately a parameter rather than a call-id-keyed registry: ids come from
 * the model, and a collision between two conversations would encrypt one's
 * content under the other's key — unreadable by either escrow record.
 */
type ToolCallContentDisposition =
  | { kind: "encrypt"; audit: LockedChatAuditContext }
  | { kind: "redact" };

class McpClient {
  private static readonly TOOL_NAME_CACHE_MAX_ENTRIES = 1_000;
  private static readonly SECRETS_CACHE_MAX_ENTRIES = 1_000;
  private static readonly SECRETS_CACHE_TTL_MS = 30_000;
  private static readonly ENTERPRISE_CREDENTIAL_CACHE_MAX_ENTRIES = 1_000;
  private static readonly ENTERPRISE_CREDENTIAL_CACHE_FALLBACK_TTL_MS = 30_000;

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
      this.latestTransportCredentialFingerprints.delete(key);
      this.activeConnectionLastValidatedAt.delete(key);
    },
  });
  private activeConnectionServerState = new Map<string, CachedServerState>();
  private activeConnectionLastValidatedAt = new Map<string, number>();
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
      outcome: OAuthRefreshOutcome;
    }>
  >();
  // Session affinity metadata discovered during transport creation.
  // Used when persisting fresh session IDs after connect().
  private pendingHttpSessionMetadata = new Map<
    string,
    { sessionEndpointUrl: string | null; sessionEndpointPodName: string | null }
  >();
  // Latest outbound HTTP credential/header fingerprint per connection key.
  // Retained until connection state is cleared so cached clients are
  // invalidated when credentials or required upstream headers change.
  private latestTransportCredentialFingerprints = new Map<string, string>();
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
      this.clearConnectionState(connectionKey);
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
   * Execute a single tool call against its assigned MCP server on behalf of a
   * tool owner (agent or app). The owner selects which assignment table gates
   * the call, scopes the connection/credential caches, and is recorded on the
   * audit row; everything else (target resolution, secrets, transport) is
   * owner-independent.
   */
  async executeToolCallForOwner(
    toolCall: CommonToolCall,
    owner: ToolOwner,
    tokenAuth?: TokenAuthContext,
    options?: ExecuteToolCallForOwnerOptions,
  ): Promise<CommonToolResult> {
    // Decided once here and handed to every path that persists a row (success,
    // error, retry, cancellation), so a concurrent call on another
    // conversation can never influence how this one's content is stored.
    const lockedChatContent = resolveContentDisposition(options);

    // Derive auth info for logging. Until a credential resolves, the call is
    // one the platform is serving itself (it may never reach a server — an app
    // launch, or a refusal), so it starts attributed to the caller and is
    // reassigned below once an upstream credential is settled.
    let authInfo: ToolCallAuthInfo | undefined =
      tokenAuth && Object.keys(tokenAuth).length
        ? {
            userId: tokenAuth.userId,
            authMethod: deriveAuthMethod(tokenAuth),
            executedAs: platformExecutedAs(tokenAuth.userId),
            executionId: tokenAuth.executionId,
          }
        : undefined;

    // Validate and get tool metadata
    const validationResult = await this.validateAndGetTool(
      toolCall,
      owner,
      options?.availableTool,
      lockedChatContent,
    );
    if ("error" in validationResult) {
      return validationResult.error;
    }
    const { tool, catalogItem, resolvedToolCall } = validationResult;
    // Use the resolved name (may have been prefixed by suffix fallback lookup)
    toolCall = resolvedToolCall;

    // SEP-2243 x-mcp-header: mirror annotated argument values into
    // Mcp-Param-* headers on the upstream call. Widening the passthrough set
    // deliberately reuses its whole pipeline — the headers are merged into the
    // transport exactly where passthrough headers are, and the credential
    // fingerprint check discards a cached connection whose baked headers no
    // longer match, so per-call values cannot leak across pooled calls.
    const mcpParamHeaders = mcpParamHeadersForCall({
      inputSchema: tool.parameters,
      args: toolCall.arguments,
    });
    if (mcpParamHeaders && tokenAuth) {
      tokenAuth = {
        ...tokenAuth,
        passthroughHeaders: {
          ...tokenAuth.passthroughHeaders,
          ...mcpParamHeaders,
        },
      };
    } else if (mcpParamHeaders) {
      // Every gateway request carries token auth, so this should be
      // unreachable — but if a call path without auth context ever reaches an
      // annotated tool, the mirrored headers are dropped, and that should be
      // visible rather than silent.
      logger.debug(
        { toolName: toolCall.name, headers: Object.keys(mcpParamHeaders) },
        "Skipping Mcp-Param headers: no token auth context to carry them",
      );
    }

    // App backing servers have no upstream to connect to: the `open` launch tool is
    // served in-process. Hand the host the app's UI resource pointer (the
    // resource itself is resolved by the gateway's resources/read path, which
    // serves it under the platform-pinned CSP). This short-circuits before any
    // transport resolution, which would have no deployment/URL for serverType
    // "app".
    if (catalogItem.serverType === "app") {
      const resourceUri = (
        tool.meta as { _meta?: { ui?: { resourceUri?: string } } } | null
      )?._meta?.ui?.resourceUri;
      // Audit the launch like any other gateway tool call. The in-process app
      // path has no upstream/transport, so success is recorded here rather than
      // after dispatch; the result still carries the ui:// pointer for the host.
      return await this.createSuccessResult({
        toolCall,
        owner,
        mcpServerName: catalogItem.name,
        content: [
          {
            type: "text",
            text: `Opening ${escapeAppNameForModelText(catalogItem.name)}.`,
          },
        ],
        isError: false,
        ...(resourceUri ? { _meta: { ui: { resourceUri } } } : {}),
        authInfo,
        lockedChatContent,
      });
    }

    const targetMcpServerIdResult =
      await this.determineTargetMcpServerIdForCatalogItem({
        tool,
        toolCall,
        owner,
        tokenAuth,
        catalogItem,
        authInfo,
        lockedChatContent,
      });
    if ("error" in targetMcpServerIdResult) {
      return targetMcpServerIdResult.error;
    }
    const { targetMcpServerId, mcpServerName, resolvedServer } =
      targetMcpServerIdResult;

    // Hold demand from before wake through dispatch. Registering only around
    // transport use leaves wake and credential resolution exposed to a sweep.
    const runDemandPath = async (): Promise<CommonToolResult> => {
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (catalogItem.serverType === "local") {
        try {
          await waitForMcpServerWake({
            mcpServerId: targetMcpServerId,
            mcpServerName,
            abortSignal: options?.abortSignal,
          });
        } catch (error) {
          if (options?.abortSignal?.aborted) {
            await this.persistToolCall({
              owner,
              mcpServerName,
              toolCall,
              toolResult: this.buildCancelledResult(toolCall, authInfo),
              authInfo,
              lockedChatContent,
            });
            throw error;
          }

          const { agentMessage, unexpected } = describeWakeFailure(
            error,
            mcpServerName,
          );
          logger[unexpected ? "error" : "warn"](
            { err: error, mcpServerId: targetMcpServerId, mcpServerName },
            "MCP server wake failed; answering the tool call with the failure",
          );
          return await this.createErrorResult({
            toolCall,
            owner,
            error: agentMessage,
            mcpServerName,
            authInfo,
            lockedChatContent,
          });
        }
      }
      // SPDX-SnippetEnd

      const effectiveEnterpriseManagedConfig =
        catalogItem.enterpriseManagedConfig ?? null;
      if (
        tool.credentialResolutionMode === "enterprise_managed" &&
        !effectiveEnterpriseManagedConfig
      ) {
        return this.createErrorResult({
          toolCall,
          owner,
          error:
            "Enterprise-managed credentials are enabled for this tool, but the MCP catalog item does not have enterprise-managed credential settings configured.",
          mcpServerName,
          authInfo,
          lockedChatContent,
        });
      }
      // A catalog-level enterprise-managed config is authoritative: assignments
      // created before enterprise mode existed (or via paths that didn't infer
      // it) still carry the default "static"/"dynamic" mode, and connecting
      // with static secrets would hit the protected server without any
      // credential. Fail closed through the exchange instead.
      const usesEnterpriseManagedCredential =
        tool.credentialResolutionMode === "enterprise_managed" ||
        effectiveEnterpriseManagedConfig !== null;
      const enterpriseTransportCredential = usesEnterpriseManagedCredential
        ? await this.resolveCachedEnterpriseTransportCredential({
            owner,
            tokenAuth,
            enterpriseManagedConfig: effectiveEnterpriseManagedConfig,
          })
        : null;

      if (usesEnterpriseManagedCredential && !enterpriseTransportCredential) {
        const authError =
          await this.buildEnterpriseManagedIdentityProviderAuthMessage(
            catalogItem.name,
            catalogItem.id,
            effectiveEnterpriseManagedConfig?.identityProviderId ?? null,
            tokenAuth,
            options,
          );
        return this.createErrorResult({
          toolCall,
          owner,
          error: authError.message,
          mcpServerName,
          authInfo,
          structuredError: authError,
          lockedChatContent,
        });
      }

      const secretsResult = await this.getSecretsForMcpServer({
        targetMcpServerId: targetMcpServerId,
        toolCall,
        owner,
        lockedChatContent,
      });
      if ("error" in secretsResult) {
        return secretsResult.error;
      }
      const { secrets, secretId, serverState, oauthRefreshErrorRecorded } =
        secretsResult;

      // A call that succeeds with the current credential disproves a recorded
      // refresh failure (e.g. a proactive refresh failed but the existing
      // token still works): the connection demonstrably operates, so the
      // re-authentication alert must go rather than flag a working server.
      const clearStaleOAuthRefreshError = async () => {
        if (!oauthRefreshErrorRecorded || !catalogItem.oauthConfig) return;
        await McpServerModel.update(targetMcpServerId, {
          oauthRefreshError: null,
          oauthRefreshErrorMessage: null,
          oauthRefreshErrorDescription: null,
          oauthRefreshFailedAt: null,
        });
        // The failure episode every mute on this connection was pinned to is
        // over, so the mutes go with it — same ordering as the refresh path:
        // dropped after the clear, never before.
        await McpServerAlertMuteModel.deleteForMcpServer(targetMcpServerId);
      };

      // The outbound credential is fully settled here (install secrets loaded,
      // enterprise exchange done), so every result below can name the identity
      // it ran as — including the ones the token-refresh retry produces.
      const executedAs = await this.describeExecutedAs({
        resolvedServer,
        tokenAuth,
        enterpriseTransportCredential,
        catalogItem,
        secrets,
      });
      if (executedAs) {
        authInfo = { ...authInfo, executedAs };
      }

      // Build connection cache key using the resolved target server ID.
      // Agents: when conversationId is provided, each (agent, conversation) gets
      // its own connection for per-session browser context isolation.
      // Apps: keyed by (app, viewing user, session) so one app's upstream session
      // never leaks across users or browser sessions.
      // When authenticated via external IdP, each user additionally gets its own
      // connection since the JWT is propagated to the underlying server per-user.
      const externalIdpUserId = tokenAuth?.isExternalIdp
        ? tokenAuth.userId
        : undefined;
      let connectionKey: string;
      if (owner.type === "agent") {
        connectionKey = options?.conversationId
          ? `${catalogItem.id}:${targetMcpServerId}:${owner.id}:${options.conversationId}`
          : `${catalogItem.id}:${targetMcpServerId}`;
      } else {
        // An app call must carry the viewing user (session auth). Without one we
        // must never collapse distinct callers onto a shared literal — that would
        // let them reuse each other's persisted upstream session. Isolate the call
        // with a per-request nonce instead, and surface the misuse.
        let userSegment = tokenAuth?.userId;
        if (!userSegment) {
          userSegment = `anon:${randomUUID()}`;
          logger.warn(
            { appId: owner.id, catalogId: catalogItem.id },
            "App tool call has no viewing user; isolating the connection per-request",
          );
        }
        const sessionSegment = options?.conversationId ?? "default";
        connectionKey = `${catalogItem.id}:${targetMcpServerId}:app:${owner.id}:${userSegment}:${sessionSegment}`;
      }
      if (externalIdpUserId) {
        connectionKey = `${connectionKey}:ext:${externalIdpUserId}`;
      }
      if (options?.elicitationHandler) {
        // Elicitation support is declared during MCP initialize. Keep these
        // clients separate so a connection opened without the capability is not
        // reused for a tool call that may receive elicitation/create requests.
        // This intentionally keeps a second cached client per server/session
        // when both interactive and non-interactive callers use the same MCP
        // server.
        connectionKey = `${connectionKey}:elicitation`;
      }

      const executeToolCall = async (
        getTransport: () => Promise<Transport>,
        currentSecrets: Record<string, unknown>,
        isRetry = false,
      ): Promise<CommonToolResult> => {
        try {
          const hasRefreshToken = !!(
            currentSecrets as { refresh_token?: string }
          ).refresh_token;
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
              owner,
              mcpServerName,
              catalogItem,
              targetMcpServerId,
              tokenAuth,
              lockedChatContent,
              enterpriseTransportCredential,
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
            options?.elicitationHandler,
          );

          // Determine the actual upstream tool name. Prefer the stored raw name
          // (tools.raw_name): it is exact even when the slug's server-prefix was
          // truncated to fit the 64-char cap or the raw name itself contains the
          // `__` separator. Fall back to prefix-stripping the slug for legacy rows
          // whose raw_name has not been backfilled/re-synced yet.
          let targetToolName: string;
          if (tool.rawName) {
            targetToolName = tool.rawName;
          } else {
            // We prioritize the `catalogName` prefix, which is standard for local
            // MCP servers. If the tool name doesn't match the catalog prefix, we
            // fall back to the resolved `mcpServerName`.
            targetToolName = this.stripServerPrefix(
              toolCall.name,
              tool.catalogName || "",
            );

            if (targetToolName === toolCall.name) {
              // No prefix match with catalogName; attempt to strip using mcpServerName instead.
              targetToolName = this.stripServerPrefix(
                toolCall.name,
                mcpServerName,
              );
            }

            if (targetToolName === toolCall.name) {
              // Neither prefix matched (e.g. server name contains MCP_SERVER_TOOL_NAME_SEPARATOR separator).
              // Fall back to parseFullToolName which uses lastIndexOf to split correctly.
              targetToolName = parseFullToolName(toolCall.name).toolName;
            }
          }

          const resourceUri = getSyntheticResourceToolUri(tool.meta);
          if (resourceUri) {
            const result = await client.readResource(
              { uri: resourceUri },
              {
                signal: options?.abortSignal,
                timeout: config.mcpGateway.toolCallTimeoutMs,
              },
            );
            await clearStaleOAuthRefreshError();
            return await this.createSuccessResult({
              toolCall,
              owner,
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
              lockedChatContent,
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
            options?.abortSignal,
          );

          const result = await client.callTool(
            {
              name: targetToolName,
              arguments: toolCall.arguments,
            },
            undefined,
            {
              signal: options?.abortSignal,
              // A detached task answers its client immediately, so the
              // synchronous patience window no longer applies — the task TTL
              // does. Without this, a task outliving the sync timeout dies at
              // the timeout even though nobody is waiting on it.
              timeout:
                options?.upstreamTimeoutMs ??
                config.mcpGateway.toolCallTimeoutMs,
            },
          );

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
              owner,
              mcpServerName,
              catalogItem,
              targetMcpServerId,
              tokenAuth,
              lockedChatContent,
              enterpriseTransportCredential,
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
            const catalogDisplayName = tool.catalogName || catalogItem.name;
            const authError = await this.buildExpiredAuthMessage({
              catalogDisplayName,
              catalogId: tool.catalogId,
              mcpServerId: targetMcpServerId,
              tokenAuth,
            });
            return await this.createErrorResult({
              toolCall,
              owner,
              error: authError.message,
              mcpServerName,
              authInfo,
              structuredError: authError,
              lockedChatContent,
            });
          }

          // Apply template and return
          await clearStaleOAuthRefreshError();
          return await this.createSuccessResult({
            toolCall,
            owner,
            mcpServerName,
            content: result.content as ContentBlock[],
            isError: !!result.isError,
            _meta: result._meta,
            authInfo,
            lockedChatContent,
            structuredContent: result.structuredContent as
              | Record<string, unknown>
              | undefined,
          });
        } catch (error) {
          // A stopped chat run aborts the request; the SDK rejects it as an
          // McpError(RequestTimeout) — indistinguishable by shape from a real
          // timeout — so key off the signal, not the error. Rethrow before any
          // recovery so an aborted call is never retried (token refresh / fresh
          // session).
          //
          // Persist the cancellation first: a call the user stopped mid-flight
          // used to vanish from the tool-call log entirely, which is exactly
          // the kind of half-finished action an operator later needs to see
          // (the upstream may have committed work before the abort landed).
          // The structured `cancelled` marker — not `isError` — is what log
          // surfaces key off, because a user-initiated stop is not a tool
          // failure. Best-effort by design: for a chat-stop abort this runs in
          // the AI SDK's abandoned tool-execute promise, so the write races
          // process shutdown; for a background-task cancel the promise is held
          // by the task's detached continuation and the write is reliable.
          if (options?.abortSignal?.aborted) {
            await this.persistToolCall({
              owner,
              mcpServerName,
              toolCall,
              toolResult: this.buildCancelledResult(toolCall, authInfo),
              authInfo,
              lockedChatContent,
            });
            throw error;
          }

          // Handle stale HTTP session.  The MCP SDK skips the `initialize`
          // handshake when `transport.sessionId` is already set (session
          // resumption), so `client.connect()` succeeds without making any
          // HTTP request.  The stale session only surfaces later as a
          // StreamableHTTPError "Session not found" during the first real
          // RPC call (listTools / callTool).  Detect this and retry with a
          // fresh session.
          const isStaleSession = isStaleSessionError(error);

          if (isStaleSession && !isRetry) {
            // Check if another concurrent call is already recovering this
            // connection (e.g. multiple browser-stream ticks firing at once).
            // If so, wait for it and reuse the fresh client it creates.
            const existingRecovery =
              this.sessionRecoveryLocks.get(connectionKey);
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
              this.clearConnectionState(connectionKey);
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
          const hasRefreshToken = !!(
            currentSecrets as { refresh_token?: string }
          ).refresh_token;

          // Track and skip recovery if no refresh token available
          if (
            isAuthError &&
            isOAuthServer &&
            targetMcpServerId &&
            !hasRefreshToken &&
            !usesClientCredentials
          ) {
            // Every later tool call against this connection lands here again;
            // `recordOAuthRefreshFailure` keeps `oauthRefreshFailedAt` at the
            // first observation so the fault has one stable start.
            await McpServerModel.recordOAuthRefreshFailure(targetMcpServerId, {
              oauthRefreshError: "no_refresh_token",
              oauthRefreshErrorMessage: "no_refresh_token",
              oauthRefreshErrorDescription: null,
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
              owner,
              mcpServerName,
              catalogItem,
              targetMcpServerId,
              tokenAuth,
              lockedChatContent,
              enterpriseTransportCredential,
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
            this.clearConnectionState(connectionKey);

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
            const catalogDisplayName = tool.catalogName || catalogItem.name;
            // Credentials exist but failed → "expired/invalid" message with manage link
            if (targetMcpServerId) {
              const [targetServer] = await McpServerModel.findByIdsBasic([
                targetMcpServerId,
              ]);
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
                return await this.createErrorResult({
                  toolCall,
                  owner,
                  error: assignmentError.message,
                  mcpServerName,
                  authInfo,
                  structuredError: assignmentError,
                  lockedChatContent,
                });
              }
              const authError = await this.buildExpiredAuthMessage({
                catalogDisplayName,
                catalogId: tool.catalogId,
                mcpServerId: targetMcpServerId,
                tokenAuth,
                resolvedServer: targetServer,
              });
              return await this.createErrorResult({
                toolCall,
                owner,
                error: authError.message,
                mcpServerName,
                authInfo,
                structuredError: authError,
                lockedChatContent,
              });
            }
            // No server resolved → "auth required" message with install link
            const authError = this.buildAuthRequiredMessage(
              catalogDisplayName,
              tool.catalogId,
              tokenAuth,
            );
            return await this.createErrorResult({
              toolCall,
              owner,
              error: authError.message,
              mcpServerName,
              authInfo,
              structuredError: authError,
              lockedChatContent,
            });
          }

          return await this.createErrorResult({
            toolCall,
            owner,
            error: errorMessage,
            mcpServerName,
            authInfo,
            lockedChatContent,
          });
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
      // The MCP SDK stores request handlers on the client by method. Serialize
      // elicitation-capable calls so a cached client's elicitation handler is
      // not replaced while another tool call on the same connection is active.
      const concurrencyLimit = options?.elicitationHandler
        ? 1
        : this.getConcurrencyLimit(transportKind);

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
    };

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (catalogItem.serverType === "local") {
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason instanceof Error
          ? options.abortSignal.reason
          : new Error("The tool call was aborted before dispatch");
      }
      return mcpActiveUseTracker.trackActiveUse(
        targetMcpServerId,
        runDemandPath,
      );
    }
    // SPDX-SnippetEnd
    return runDemandPath();
  }

  /**
   * Get or create a client with the given transport
   */
  private async getOrCreateClient(
    connectionKey: string,
    transport: Transport,
    targetMcpServerId: string,
    currentServerState: CachedServerState,
    elicitationHandler?: McpElicitationHandler,
  ): Promise<Client> {
    const effectiveServerState = this.withLatestCredentialFingerprint(
      connectionKey,
      currentServerState,
    );

    // Check if we already have an active connection
    const existingClient = this.activeConnections.get(connectionKey);
    if (existingClient) {
      const cachedServerState =
        this.activeConnectionServerState.get(connectionKey);
      if (
        !cachedServerState ||
        !this.hasMatchingServerState(cachedServerState, effectiveServerState)
      ) {
        logger.info(
          {
            connectionKey,
            targetMcpServerId,
            cachedSecretId: cachedServerState?.secretId ?? null,
            currentSecretId: effectiveServerState.secretId,
          },
          "Discarding cached MCP client after MCP server credentials changed",
        );
        try {
          await existingClient.close();
        } catch (error) {
          logger.warn(
            { connectionKey, targetMcpServerId, error },
            "Error closing stale cached MCP client after credential change",
          );
        }
        this.clearConnectionState(connectionKey);
      }
    }

    const reusableClient = this.activeConnections.get(connectionKey);
    if (reusableClient) {
      // Health check idle clients to verify the connection is still alive.
      // Recently-used clients skip the ping and recover on actual call failure.
      try {
        if (this.shouldValidateActiveConnection(connectionKey)) {
          await reusableClient.ping();
          this.activeConnectionLastValidatedAt.set(connectionKey, Date.now());
        }
        logger.debug({ connectionKey }, "Reusing cached MCP client");
        if (elicitationHandler) {
          configureMcpElicitation(reusableClient, elicitationHandler);
        }
        this.activeConnections.set(connectionKey, reusableClient);
        this.activeConnectionServerState.set(
          connectionKey,
          effectiveServerState,
        );
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
        this.clearConnectionState(connectionKey);
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
    // No `roots`: nothing here implements `roots/list`, and declaring it
    // invited upstream servers to call a method we always failed. Deprecated
    // in 2026-07-28 besides.
    const baseCapabilities: ClientCapabilitiesWithExtensions = {
      extensions: mcpClientExtensionCapabilities(),
    };
    const capabilities = elicitationHandler
      ? withMcpElicitationCapability(baseCapabilities)
      : baseCapabilities;

    // Create new client
    logger.info({ connectionKey }, "Creating new MCP client");
    const client = new Client(buildMcpClientInfo("archestra-platform"), {
      capabilities,
    });
    if (elicitationHandler) {
      configureMcpElicitation(client, elicitationHandler);
    }

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
    this.activeConnectionServerState.set(connectionKey, effectiveServerState);
    this.activeConnectionLastValidatedAt.set(connectionKey, Date.now());

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

  private shouldValidateActiveConnection(connectionKey: string): boolean {
    const lastValidatedAt =
      this.activeConnectionLastValidatedAt.get(connectionKey) ?? 0;
    return (
      Date.now() - lastValidatedAt >=
      ACTIVE_CONNECTION_PING_VALIDATION_INTERVAL_MS
    );
  }

  private clearConnectionState(connectionKey: string): void {
    this.activeConnections.delete(connectionKey);
    this.activeConnectionServerState.delete(connectionKey);
    this.toolNameCache.delete(connectionKey);
    this.pendingHttpSessionMetadata.delete(connectionKey);
    this.latestTransportCredentialFingerprints.delete(connectionKey);
    this.activeConnectionLastValidatedAt.delete(connectionKey);
  }

  private clearAllConnectionState(): void {
    this.activeConnections.clear();
    this.activeConnectionServerState.clear();
    this.toolNameCache.clear();
    this.pendingHttpSessionMetadata.clear();
    this.latestTransportCredentialFingerprints.clear();
    this.activeConnectionLastValidatedAt.clear();
  }

  /**
   * Validate tool and get metadata
   */
  private async validateAndGetTool(
    toolCall: CommonToolCall,
    owner: ToolOwner,
    availableTool?: CatalogTool,
    lockedChatContent?: ToolCallContentDisposition,
  ): Promise<
    | {
        tool: McpToolAssignment;
        catalogItem: InternalMcpCatalog;
        resolvedToolCall: CommonToolCall;
      }
    | { error: CommonToolResult }
  > {
    // Get the MCP tool from the owner's assigned tools (agent_tools or app_tools).
    let mcpTools =
      owner.type === "agent"
        ? await ToolModel.getMcpToolsAssignedToAgent([toolCall.name], owner.id)
        : await ToolModel.getMcpToolsAssignedToApp([toolCall.name], owner.id);

    // Fallback: if the name has no server prefix (no MCP_SERVER_TOOL_NAME_SEPARATOR), try finding a tool
    // that ends with "__<name>". This handles MCP App iframes calling oncalltool
    // with the raw tool name (e.g. "refresh-stats" instead of "system__refresh-stats"),
    // which happens when third-party hosts render MCP Apps.
    if (
      mcpTools.length === 0 &&
      !toolCall.name.includes(MCP_SERVER_TOOL_NAME_SEPARATOR)
    ) {
      mcpTools =
        owner.type === "agent"
          ? await ToolModel.getMcpToolsAssignedToAgentBySuffix(
              toolCall.name,
              owner.id,
            )
          : await ToolModel.getMcpToolsAssignedToAppBySuffix(
              toolCall.name,
              owner.id,
            );
      if (mcpTools.length > 0) {
        // Use the full prefixed name for downstream execution but don't mutate the caller's object.
        toolCall = { ...toolCall, name: mcpTools[0].toolName };
      }
    }

    let tool: McpToolAssignment | undefined = mcpTools[0];

    const accessAllTools =
      owner.type === "agent" && (await AgentModel.getAccessAllTools(owner.id));

    // Per-agent exclusions (Auto-tool mode). Loaded once here and reused for
    // both the precedence resolution just below and the final execution gate
    // further down, so a single dispatch never queries them twice.
    const exclusionSets = accessAllTools
      ? await agentToolExclusionsService.getExclusionSets(owner.id)
      : null;

    // Assigned rows normally keep precedence over the dispatcher's
    // dynamically-resolved row. But tool names are unique only per catalog, so a
    // name can back an assigned row in one catalog AND a discoverable row in
    // another. When the assigned row is EXCLUDED while the dispatcher resolved a
    // non-excluded same-named row, letting the assigned row win would refuse a
    // tool search_tools/run_tool just advertised. Drop the excluded assigned row
    // so the dynamic row below takes over.
    if (
      tool &&
      exclusionSets &&
      availableTool &&
      availableTool.name === toolCall.name &&
      isToolIdentityExcluded(
        { catalogId: tool.catalogId, name: tool.toolName },
        exclusionSets,
      ) &&
      !isToolIdentityExcluded(
        { catalogId: availableTool.catalogId, name: availableTool.name },
        exclusionSets,
      )
    ) {
      tool = undefined;
    }

    // Dynamic tool access ("Auto" mode): the dispatcher pre-resolved a
    // tool the agent has no assignment row for. Shape it like an assignment so
    // downstream resolution is identical. It has no row to inherit a credential
    // mode from and can't carry a static pin, so it resolves its connection at
    // call time — which still defers to the MCP server's connection policy
    // (on-behalf-of the caller, or a pinned service account). An assigned row
    // keeps precedence here; in "Auto" mode the override below then routes
    // even a leftover static assignment through the server's connection policy.
    if (!tool && availableTool && availableTool.name === toolCall.name) {
      tool = {
        toolName: availableTool.name,
        parameters:
          (availableTool.parameters as Record<string, unknown> | null) ?? null,
        rawName: availableTool.rawName,
        mcpServerId: null,
        credentialResolutionMode: "dynamic",
        catalogId: availableTool.catalogId,
        catalogName: null,
        meta: availableTool.meta ?? null,
      };
    }

    if (!tool) {
      const message = unavailableThirdPartyToolMessage(toolCall.name);
      return {
        error: await this.createErrorResult({
          toolCall,
          owner,
          error: message,
          mcpServerName: "unknown",
          structuredError: {
            type: "tool_state",
            code: "unknown_tool",
            message,
            toolName: toolCall.name,
          },
          lockedChatContent,
        }),
      };
    }

    // Per-agent exclusions (Auto-tool mode) — the deep execution gate backing
    // every dispatch path (gateway tools/call, run_tool, and chat's CACHED
    // AI-SDK tool wrappers, which execute here without re-entering the gateway
    // handler). Checked by resolved tool identity, after suffix recovery and
    // dynamic-dispatch resolution, so no alias can bypass it. Excluded tools
    // surface as unavailable, matching the discovery-side refusals.
    if (
      exclusionSets &&
      isToolIdentityExcluded(
        { catalogId: tool.catalogId, name: tool.toolName },
        exclusionSets,
      )
    ) {
      const message = unavailableThirdPartyToolMessage(toolCall.name);
      return {
        error: await this.createErrorResult({
          toolCall,
          owner,
          error: message,
          mcpServerName: tool.catalogName || "unknown",
          structuredError: {
            type: "tool_state",
            code: "unknown_tool",
            message,
            toolName: toolCall.name,
          },
          lockedChatContent,
        }),
      };
    }

    // "Auto" mode overrides a leftover per-tool credential pin. When the
    // agent has access_all_tools on, credentials follow the MCP server's
    // connection policy (on-behalf-of the caller, or a pinned service account)
    // for every tool — a static assignment left over from Custom mode must not
    // dictate the credential. The assignment row stays in the DB so switching
    // back to Custom restores it. Only static pins are rewritten; dynamic is
    // already server-policy and enterprise-managed keeps its own mechanism.
    if (tool.credentialResolutionMode === "static" && accessAllTools) {
      logger.info(
        {
          toolName: toolCall.name,
          agentId: owner.id,
          mcpServerId: tool.mcpServerId,
        },
        "Auto tool mode: ignoring static assignment pin, resolving via the MCP server's default-credential policy",
      );
      tool = {
        ...tool,
        mcpServerId: null,
        credentialResolutionMode: "dynamic",
      };
    }

    // Validate catalogId
    if (!tool.catalogId) {
      return {
        error: await this.createErrorResult({
          toolCall,
          owner,
          error: "Tool is missing catalogId",
          mcpServerName: tool.catalogName || "unknown",
          lockedChatContent,
        }),
      };
    }

    // Get catalog item
    const catalogItem = await InternalMcpCatalogModel.findById(tool.catalogId);
    if (!catalogItem) {
      return {
        error: await this.createErrorResult({
          toolCall,
          owner,
          error: `No catalog item found for tool catalog ID ${tool.catalogId}`,
          mcpServerName: tool.catalogName || "unknown",
          lockedChatContent,
        }),
      };
    }

    return { tool, catalogItem, resolvedToolCall: toolCall };
  }

  // Gets secrets of a given MCP server, with short-lived caching to prevent
  // N+1 queries when multiple tool calls target the same server.
  private async getSecretsForMcpServer({
    targetMcpServerId,
    toolCall,
    owner,
    lockedChatContent,
  }: {
    targetMcpServerId: string;
    toolCall: CommonToolCall;
    owner: ToolOwner;
    lockedChatContent?: ToolCallContentDisposition;
  }): Promise<
    | {
        secrets: Record<string, unknown>;
        secretId?: string;
        serverState: CachedServerState;
        /** The row carries a recorded refresh failure right now. */
        oauthRefreshErrorRecorded: boolean;
      }
    | { error: CommonToolResult }
  > {
    // Resolving secrets only needs the base server row (id + secretId).
    // findById() additionally performs a 4-table join and a per-server
    // mcp_server_user lookup, which turns into an N+1 when several tool calls
    // in the same turn target the same server. Use the lightweight lookup.
    const [mcpServer] = await McpServerModel.findByIdsBasic([
      targetMcpServerId,
    ]);
    if (!mcpServer) {
      return {
        error: await this.createErrorResult({
          toolCall,
          owner,
          error: `MCP server not found when getting secrets for MCP server ${targetMcpServerId}`,
          mcpServerName: "unknown",
          lockedChatContent,
        }),
      };
    }

    const currentServerState = this.toCachedServerState(mcpServer);
    const oauthRefreshErrorRecorded = !!mcpServer.oauthRefreshError;
    const cached = this.secretsCache.get(targetMcpServerId);
    if (cached?.secretId === currentServerState.secretId) {
      return {
        ...cached,
        serverState: currentServerState,
        oauthRefreshErrorRecorded,
      };
    }

    if (cached) {
      this.secretsCache.delete(targetMcpServerId);
    }

    const result = await this.fetchSecretsForLoadedMcpServer(mcpServer);

    this.secretsCache.set(targetMcpServerId, {
      secrets: result.secrets,
      secretId: result.secretId,
    });

    return { ...result, oauthRefreshErrorRecorded };
  }

  private async fetchSecretsForLoadedMcpServer(mcpServer: {
    id: string;
    secretId: string | null;
  }): Promise<{
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
    owner,
    catalogItem,
    authInfo,
    lockedChatContent,
  }: {
    tool: McpToolAssignment;
    toolCall: CommonToolCall;
    owner: ToolOwner;
    tokenAuth?: TokenAuthContext;
    catalogItem: InternalMcpCatalog;
    lockedChatContent?: ToolCallContentDisposition;
    // Identity of the caller, so a refusal here is recorded and rendered like
    // any other result rather than as an anonymous error.
    authInfo?: ToolCallAuthInfo;
  }): Promise<
    | {
        targetMcpServerId: string;
        mcpServerName: string;
        // The install whose stored credential serves the call, so the caller
        // can report which identity the upstream call ran as. Null only when
        // the install row could not be loaded (a pin whose row vanished
        // between resolution and lookup).
        resolvedServer: ResolvedInstallIdentity | null;
      }
    | { error: CommonToolResult }
  > {
    const fallbackName = tool.catalogName || "unknown";
    // Never log tokenAuth/tool wholesale: tokenAuth can carry a raw bearer
    // JWT and passthrough header values; log identifying fields only.
    logger.info(
      {
        toolName: toolCall.name,
        toolCatalogId: tool.catalogId,
        toolMcpServerId: tool.mcpServerId,
        credentialResolutionMode: tool.credentialResolutionMode,
        tokenAuth: tokenAuth && {
          tokenId: tokenAuth.tokenId,
          teamId: tokenAuth.teamId,
          userId: tokenAuth.userId,
          isOrganizationToken: tokenAuth.isOrganizationToken,
          isUserToken: tokenAuth.isUserToken,
          isExternalIdp: tokenAuth.isExternalIdp,
          isSessionAuth: tokenAuth.isSessionAuth,
        },
      },
      "Determining target MCP server ID for catalog item",
    );
    // Static credential case: tool has a bound MCP server credential to use.
    if (tool.credentialResolutionMode === "static") {
      if (!tool.mcpServerId) {
        // The pinned install was uninstalled but the assignment is retained.
        // Route through a remaining install for the same catalog (a multi-tenant
        // sibling, or a reconnect not yet re-pinned), else return the typed
        // "reconnect" result. catalogItem is the resolved catalog for this tool,
        // so use its id rather than the assignment's possibly-stale catalogId.
        const installs = await McpServerModel.findByCatalogId(catalogItem.id);
        const resolved = await this.pickInstallForCaller(installs, tokenAuth);
        if (resolved) {
          return {
            targetMcpServerId: resolved.id,
            mcpServerName: resolved.name,
            resolvedServer: resolved,
          };
        }
        const reconnectError = this.buildReconnectRequiredMessage(
          tool.catalogName || catalogItem.name,
          catalogItem.id,
        );
        return {
          error: await this.createErrorResult({
            toolCall,
            owner,
            error: reconnectError.message,
            mcpServerName: fallbackName,
            authInfo,
            structuredError: reconnectError,
            lockedChatContent,
          }),
        };
      }
      // Only the display name is needed here, so avoid the heavier findById().
      const [mcpServer] = await McpServerModel.findByIdsBasic([
        tool.mcpServerId,
      ]);
      logger.info(
        {
          toolName: toolCall.name,
          catalogItemId: catalogItem.id,
          catalogItemName: catalogItem.name,
          targetMcpServerId: tool.mcpServerId,
        },
        "Determined target MCP server ID for catalog item",
      );
      return {
        targetMcpServerId: tool.mcpServerId,
        mcpServerName: mcpServer?.name || fallbackName,
        resolvedServer: mcpServer ?? null,
      };
    }

    // If mcp server is configured to use enterprise-managed credentials, we can use any pod.
    // Mcp server pod will request credentials from the IDP.
    if (tool.credentialResolutionMode === "enterprise_managed") {
      const explicitTargetMcpServerId = tool.mcpServerId;
      if (explicitTargetMcpServerId) {
        const [mcpServer] = await McpServerModel.findByIdsBasic([
          explicitTargetMcpServerId,
        ]);
        return {
          targetMcpServerId: explicitTargetMcpServerId,
          mcpServerName: mcpServer?.name || fallbackName,
          resolvedServer: mcpServer ?? null,
        };
      }

      const allServers = await McpServerModel.findByCatalogId(
        tool.catalogId ?? "",
      );
      const resolvedServer = allServers[0];
      if (!resolvedServer) {
        return {
          error: await this.createErrorResult({
            toolCall,
            owner,
            error:
              "Enterprise-managed credentials are configured, but no MCP server installation is available for this catalog.",
            mcpServerName: fallbackName,
            authInfo,
            lockedChatContent,
          }),
        };
      }

      return {
        targetMcpServerId: resolvedServer.id,
        mcpServerName: resolvedServer.name,
        resolvedServer,
      };
    }

    // Dynamic credential (resolved on tool call time) case: resolve target MCP server ID based on tokenAuth
    // tokenAuth are profile tokens autocreated when team is assigned to a profile
    if (!tokenAuth) {
      return {
        error: await this.createErrorResult({
          toolCall,
          owner,
          error:
            "Dynamic team credential is enabled but no token authentication provided. Use a profile token to authenticate.",
          mcpServerName: fallbackName,
          authInfo,
          lockedChatContent,
        }),
      };
    }
    if (!tool.catalogId) {
      return {
        error: await this.createErrorResult({
          toolCall,
          owner,
          error:
            "Dynamic team credential is enabled but tool has no catalogId.",
          mcpServerName: fallbackName,
          authInfo,
          lockedChatContent,
        }),
      };
    }

    // Get all servers for this catalog
    const allServers = await McpServerModel.findByCatalogId(tool.catalogId);

    // The catalog item defines how agents connect to it. A pinned connection
    // ("service account") routes every runtime-resolved call through that one
    // installation, regardless of the caller. The pin is re-validated against
    // the catalog's installs on every call (no DB-level FK — see the schema
    // comment), so a revoked connection degrades to resolve-at-call-time.
    if (catalogItem.dynamicConnectionMcpServerId) {
      const pinnedServer = allServers.find(
        (s) => s.id === catalogItem.dynamicConnectionMcpServerId,
      );
      if (pinnedServer) {
        logger.info(
          {
            toolName: toolCall.name,
            catalogId: tool.catalogId,
            serverId: pinnedServer.id,
          },
          `Connection resolution: using the catalog's pinned service-account connection for tool ${toolCall.name}`,
        );
        return {
          targetMcpServerId: pinnedServer.id,
          mcpServerName: pinnedServer.name,
          resolvedServer: pinnedServer,
        };
      }
      logger.warn(
        {
          toolName: toolCall.name,
          catalogId: tool.catalogId,
          dynamicConnectionMcpServerId:
            catalogItem.dynamicConnectionMcpServerId,
        },
        "Connection resolution: the catalog's pinned connection no longer exists; resolving at call time",
      );
    }

    // Resolve at call time (no pinned connection). The chatting identity's own
    // connection takes priority, then falls back to a connection it can access:
    // user token -> personal, then a team the user belongs to, then org-scoped;
    // team token -> the team's connection, then org-scoped. Pinning a service
    // account (above) overrides this to force one connection for every caller.
    const resolvedServer = await this.pickInstallForCaller(
      allServers,
      tokenAuth,
    );
    if (resolvedServer) {
      logger.info(
        {
          toolName: toolCall.name,
          catalogId: tool.catalogId,
          serverId: resolvedServer.id,
        },
        `Dynamic resolution: using scoped install for tool ${toolCall.name}`,
      );
      return {
        targetMcpServerId: resolvedServer.id,
        mcpServerName: resolvedServer.name,
        resolvedServer,
      };
    }

    // Org-wide token is incompatible with dynamic credential resolution
    if (tokenAuth.isOrganizationToken) {
      return {
        error: await this.createErrorResult({
          toolCall,
          owner,
          error:
            "Organization-wide tokens are not supported for tools with dynamic credential resolution. Use a personal or team token instead.",
          mcpServerName: fallbackName,
          authInfo,
          lockedChatContent,
        }),
      };
    }

    // Fallback for external IdP users if earlier resolution didn't match.
    // Another user's personal install is never eligible — its stored
    // credentials must not serve other callers; JWKS deployments share
    // org/team-scoped installs (or ownerless service rows).
    // TODO: works only we are doing end-to-end JWKS pattern.
    if (tokenAuth.isExternalIdp) {
      const idpFallbackServer = allServers.find(
        (s) =>
          !(
            s.ownerId &&
            s.ownerId !== tokenAuth.userId &&
            !s.teamId &&
            s.scope !== "org"
          ),
      );
      if (idpFallbackServer) {
        logger.info(
          {
            toolName: toolCall.name,
            catalogId: tool.catalogId,
            serverId: idpFallbackServer.id,
          },
          `Dynamic resolution: using first available server for external IdP user`,
        );
        return {
          targetMcpServerId: idpFallbackServer.id,
          mcpServerName: idpFallbackServer.name,
          resolvedServer: idpFallbackServer,
        };
      }
    }

    // No server found. Offer a self-service install link only when the caller
    // can actually reach it; otherwise the catalog item is not shared with them
    // (e.g. another user's personal-scope server) and the link is a dead end.
    const catalogDisplayName = tool.catalogName || catalogItem.name;
    const authError = (await this.callerCanConnectCatalog(
      tool.catalogId,
      tokenAuth,
    ))
      ? this.buildAuthRequiredMessage(
          catalogDisplayName,
          tool.catalogId,
          tokenAuth,
        )
      : this.buildConnectionUnavailableMessage(
          catalogDisplayName,
          tool.catalogId,
        );
    return {
      error: await this.createErrorResult({
        toolCall,
        owner,
        error: authError.message,
        mcpServerName: fallbackName,
        authInfo,
        structuredError: authError,
        lockedChatContent,
      }),
    };
  }

  // Picks which of a catalog's installs the calling identity routes through, using
  // the runtime credential-resolution scope priority: a user token prefers its own
  // personal install, then a team the user belongs to, then an org-scoped install;
  // a team token prefers the team's install, then org-scoped. Returns undefined when
  // none match. Shared by dynamic resolution and by a retained static assignment
  // whose pinned install was uninstalled (its mcpServerId is null).
  private async pickInstallForCaller(
    allServers: McpServer[],
    tokenAuth: TokenAuthContext | undefined,
  ): Promise<McpServer | undefined> {
    if (tokenAuth?.userId) {
      const userServer = allServers.find(
        (s) => s.ownerId === tokenAuth.userId && !s.teamId && s.scope !== "org",
      );
      if (userServer) return userServer;

      const userTeams = await TeamModel.getUserTeams(tokenAuth.userId);
      const userTeamIds = new Set(userTeams.map((t) => t.id));
      const teamServer = allServers.find(
        (s) => s.teamId && userTeamIds.has(s.teamId),
      );
      if (teamServer) return teamServer;

      const orgServer = allServers.find((s) => s.scope === "org");
      if (orgServer) return orgServer;
    }

    if (tokenAuth?.teamId) {
      const teamServer = allServers.find((s) => s.teamId === tokenAuth.teamId);
      if (teamServer) return teamServer;

      const orgServer = allServers.find((s) => s.scope === "org");
      if (orgServer) return orgServer;
    }

    return undefined;
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
          applyEnterpriseCredentialHeader(
            localHeaders,
            enterpriseTransportCredential,
          );
        } else if (
          !staticCredentialsProvideAuthorization({ catalogItem, secrets }) &&
          tokenAuth?.isExternalIdp &&
          tokenAuth.rawToken
        ) {
          // Fallback: propagate external IdP JWT for end-to-end JWKS pattern
          // (upstream server validates the same JWT against the IdP's JWKS)
          localHeaders.Authorization = `Bearer ${tokenAuth.rawToken}`;
        }

        mergePassthroughHeaders(localHeaders, tokenAuth?.passthroughHeaders);
        this.trackTransportCredentialFingerprint(connectionKey, localHeaders);

        return new StreamableHTTPClientTransport(new URL(endpointUrl), {
          sessionId,
          requestInit: { headers: new Headers(localHeaders) },
        });
      }

      if (catalogItem.serverType === "remote") {
        if (!catalogItem.serverUrl) {
          throw new Error("Remote server missing serverUrl");
        }

        // Runtime egress enforcement: refuse the outbound connection when the
        // server's host is not permitted by its environment's network policy.
        // This is the actual boundary — it also catches grandfathered servers
        // and servers whose environment policy was tightened after creation,
        // which the create/edit-time check does not re-validate. Applies to
        // both tool calls and tools/list inspection (both build the transport
        // here). Skipped only when org context can't be resolved.
        const organizationId =
          catalogItem.organizationId ?? tokenAuth?.organizationId;
        if (organizationId) {
          const verdict = await evaluateRemoteServerUrlAgainstNetworkPolicy({
            serverType: "remote",
            serverUrl: catalogItem.serverUrl,
            environmentId: catalogItem.environmentId,
            organizationId,
          });
          if (!verdict.allowed) {
            throw new Error(verdict.message);
          }
        }

        const headers = buildStaticCredentialHeaders({
          catalogItem,
          secrets,
        });
        if (enterpriseTransportCredential) {
          applyEnterpriseCredentialHeader(
            headers,
            enterpriseTransportCredential,
          );
        } else if (
          !staticCredentialsProvideAuthorization({ catalogItem, secrets }) &&
          tokenAuth?.isExternalIdp &&
          tokenAuth.rawToken
        ) {
          // Fallback: propagate external IdP JWT for end-to-end JWKS pattern
          // (upstream server validates the same JWT against the IdP's JWKS)
          headers.Authorization = `Bearer ${tokenAuth.rawToken}`;
        }

        mergePassthroughHeaders(headers, tokenAuth?.passthroughHeaders);
        this.trackTransportCredentialFingerprint(connectionKey, headers);

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
    abortSignal?: AbortSignal,
  ): Promise<string> {
    let nameMap = this.toolNameCache.get(connectionKey);
    if (!nameMap) {
      try {
        const toolsResult = await client.listTools(undefined, {
          signal: abortSignal,
        });
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

  // The reserved `_meta` entry naming the identity a call ran as, or nothing
  // when no upstream credential was resolved (a platform built-in, an app
  // launch, or a failure before resolution).
  private executedAsMeta(
    authInfo: ToolCallAuthInfo | undefined,
  ): Record<string, McpExecutedAs> {
    return authInfo?.executedAs
      ? { [MCP_EXECUTED_AS_META_KEY]: authInfo.executedAs }
      : {};
  }

  /**
   * The row persisted for a call aborted mid-flight. `isError` stays false —
   * a user-initiated stop is not a tool failure — and the structured
   * `cancelled` marker is what the log surfaces render as their distinct
   * Cancelled state. Never returned to the caller: the abort rethrows, and
   * this row exists purely so the call doesn't vanish from the audit surface.
   */
  private buildCancelledResult(
    toolCall: CommonToolCall,
    authInfo?: ToolCallAuthInfo,
  ): CommonToolResult {
    const message =
      "Cancelled before it finished — the run was stopped or the background task was cancelled. The upstream server may have completed work before the cancellation landed.";
    return {
      id: toolCall.id,
      name: toolCall.name,
      content: [{ type: "text", text: message }],
      isError: false,
      _meta: {
        archestraError: { type: "cancelled", message },
        ...this.executedAsMeta(authInfo),
      },
    };
  }

  /**
   * Create and persist an error result
   */
  private async createErrorResult(opts: {
    toolCall: CommonToolCall;
    owner: ToolOwner;
    error: string;
    mcpServerName?: string;
    authInfo?: ToolCallAuthInfo;
    structuredError?: McpToolError;
    lockedChatContent?: ToolCallContentDisposition;
  }): Promise<CommonToolResult> {
    const {
      toolCall,
      owner,
      error,
      mcpServerName = "unknown",
      authInfo,
      structuredError,
      lockedChatContent,
    } = opts;
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
        ...this.executedAsMeta(authInfo),
      },
      structuredContent: {
        archestraError: normalizedError,
      },
    };

    await this.persistToolCall({
      owner,
      mcpServerName,
      toolCall,
      toolResult: errorResult,
      authInfo,
      lockedChatContent,
    });
    return errorResult;
  }

  /**
   * Create success result with template application
   */
  private async createSuccessResult(opts: {
    toolCall: CommonToolCall;
    owner: ToolOwner;
    mcpServerName: string;
    content: ContentBlock[];
    isError: boolean;
    _meta?: Record<string, unknown>;
    authInfo?: ToolCallAuthInfo;
    structuredContent?: Record<string, unknown>;
    lockedChatContent?: ToolCallContentDisposition;
  }): Promise<CommonToolResult> {
    const {
      toolCall,
      owner,
      mcpServerName,
      content,
      isError,
      _meta,
      authInfo,
      structuredContent,
      lockedChatContent,
    } = opts;

    // `archestraError`, the seeded-app-render marker and the executed-as
    // identity are platform-reserved envelopes: error renderers, the
    // trusted-data guardrail and the tool card key off them to identify
    // platform-authored results. Only the platform sets them, so strip any copy
    // an upstream tool put in its result metadata — otherwise a hostile server
    // could forge a dispatch error, a seeded-render marker or an identity, and
    // slip untrusted output past the injection scan. The platform's own
    // executed-as value goes on after the strip.
    const executedAsMeta = this.executedAsMeta(authInfo);
    const strippedMeta = stripReservedPlatformMeta(_meta);
    const toolResult: CommonToolResult = {
      id: toolCall.id,
      name: toolCall.name,
      content,
      isError,
      _meta:
        strippedMeta || Object.keys(executedAsMeta).length
          ? { ...strippedMeta, ...executedAsMeta }
          : undefined,
      structuredContent: stripReservedPlatformMeta(structuredContent),
    };

    await this.persistToolCall({
      owner,
      mcpServerName,
      toolCall,
      toolResult,
      authInfo,
      lockedChatContent,
    });
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
    owner: ToolOwner;
    mcpServerName: string;
    catalogItem: InternalMcpCatalog;
    targetMcpServerId: string;
    tokenAuth?: TokenAuthContext;
    enterpriseTransportCredential?: ResolvedEnterpriseTransportCredential | null;
    toolCatalogId: string | null;
    toolCatalogName: string | null;
    lockedChatContent?: ToolCallContentDisposition;
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
      owner,
      mcpServerName,
      catalogItem,
      targetMcpServerId,
      tokenAuth,
      enterpriseTransportCredential,
      toolCatalogId,
      toolCatalogName,
      executeRetry,
      lockedChatContent,
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
        {
          toolName: toolCall.name,
          secretId,
          classification: refreshResult.outcome.ok
            ? undefined
            : refreshResult.outcome.kind,
        },
        "attemptTokenRefreshAndRetry: token refresh failed",
      );

      // Only a terminal failure changes persisted connection health; a
      // transient failure persists nothing and is re-attempted next use.
      const failureFields = refreshFailureToServerFields(refreshResult.outcome);
      if (failureFields) {
        await McpServerModel.recordOAuthRefreshFailure(
          targetMcpServerId,
          failureFields,
        );
      }

      return null;
    }

    logger.info(
      { toolName: toolCall.name, secretId },
      "attemptTokenRefreshAndRetry: token refreshed, retrying tool call",
    );

    // Clear any previous refresh error since refresh succeeded
    await McpServerModel.update(targetMcpServerId, {
      oauthRefreshError: null,
      oauthRefreshErrorMessage: null,
      oauthRefreshErrorDescription: null,
      oauthRefreshFailedAt: null,
    });

    // The failure episode every mute on this connection was pinned to is over,
    // so the mutes go with it. Dropped after the clear, never before: if the
    // clear had failed, a still-valid mute must survive.
    await McpServerAlertMuteModel.deleteForMcpServer(targetMcpServerId);

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
          connectionKey,
          tokenAuth,
          enterpriseTransportCredential ?? undefined,
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
        const catalogDisplayName = toolCatalogName || catalogItem.name;
        const authError = await this.buildExpiredAuthMessage({
          catalogDisplayName,
          catalogId: toolCatalogId,
          mcpServerId: targetMcpServerId,
          tokenAuth,
        });
        return await this.createErrorResult({
          toolCall,
          owner,
          error: authError.message,
          mcpServerName,
          structuredError: authError,
          lockedChatContent,
        });
      }

      return await this.createErrorResult({
        toolCall,
        owner,
        error: retryErrorMsg,
        mcpServerName,
        lockedChatContent,
      });
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
    outcome: OAuthRefreshOutcome;
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

    const refreshPromise = (async (): Promise<{
      refreshed: boolean;
      updatedSecret: Record<string, unknown> | null;
      outcome: OAuthRefreshOutcome;
    }> => {
      const existingClient = this.activeConnections.get(connectionKey);
      if (existingClient) {
        try {
          await existingClient.close();
        } catch {
          // Ignore close errors during refresh teardown.
        }
        this.clearConnectionState(connectionKey);
      }

      const outcome = await refreshOAuthToken(secretId, catalogId);
      if (!outcome.ok) {
        return { refreshed: false, updatedSecret: null, outcome };
      }

      const updatedSecret = await secretManager().getSecret(secretId);
      if (!updatedSecret?.secret) {
        logger.warn(
          { secretId, catalogId },
          "OAuth token refresh succeeded but updated secret could not be loaded",
        );
        // Refresh itself succeeded; the secret-load blip is transient and
        // must not flip the connection into needs-reauthentication.
        return {
          refreshed: false,
          updatedSecret: null,
          outcome: { ok: false, kind: "transient", reason: "network" },
        };
      }

      this.secretsCache.set(targetMcpServerId, {
        secrets: updatedSecret.secret,
        secretId,
      });

      return { refreshed: true, updatedSecret: updatedSecret.secret, outcome };
    })()
      .catch((error) => {
        logger.error(
          { secretId, catalogId, error },
          "OAuth token refresh lock encountered an unexpected error",
        );
        return {
          refreshed: false,
          updatedSecret: null,
          outcome: classifyThrownRefreshError(error),
        };
      })
      .finally(() => {
        this.oauthRefreshLocks.delete(secretId);
      });

    this.oauthRefreshLocks.set(secretId, refreshPromise);
    return refreshPromise;
  }

  /**
   * Whether the calling identity could set up its own connection for a catalog
   * item — i.e. the item is visible and installable to it. A user token that
   * cannot (another user's personal-scope item, or a team item for a team it is
   * not in) must not be handed a self-service install link it cannot act on.
   * Team/org-token callers, callers whose organization is unknown, and any
   * lookup error fall back to the install-link guidance rather than being
   * suppressed.
   */
  private async callerCanConnectCatalog(
    catalogId: string,
    tokenAuth?: TokenAuthContext,
  ): Promise<boolean> {
    if (!tokenAuth?.userId || !tokenAuth.organizationId) {
      return true;
    }
    try {
      const checker = await getMcpCatalogPermissionChecker({
        userId: tokenAuth.userId,
        organizationId: tokenAuth.organizationId,
      });
      const accessibleIds =
        await McpCatalogTeamModel.getUserAccessibleCatalogIds(
          tokenAuth.userId,
          checker.isAdmin,
          tokenAuth.organizationId,
        );
      return accessibleIds.includes(catalogId);
    } catch {
      return true;
    }
  }

  /**
   * Auth-required error for a caller who cannot set up their own connection to
   * the catalog item because it is not shared with them. Carries no install
   * `actionUrl` or `action`, so no client (chat card, non-UI client, or the
   * model relaying the text) presents a self-service link the caller cannot use;
   * the message names the remediations open to them.
   */
  private buildConnectionUnavailableMessage(
    catalogDisplayName: string,
    catalogId: string,
  ): AuthRequiredMcpToolError {
    return {
      type: "auth_required",
      message:
        `The tool's MCP server "${catalogDisplayName}" is not shared with you, ` +
        "so it cannot run for you and you cannot set up your own connection to it. " +
        "Ask the server's owner or an administrator to share it with your team or organization, " +
        "to designate a shared connection for it, or to run this tool on your behalf.",
      catalogId,
      catalogName: catalogDisplayName,
    };
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
   * Like buildAuthRequiredMessage but worded for a retained tool whose MCP
   * connection was uninstalled (no install remains for its catalog). Same typed
   * shape/action so clients handle it identically; only the human-readable
   * message is reconnect-framed, matching the search_tools "not installed —
   * reconnect" wording rather than "no credentials".
   */
  private buildReconnectRequiredMessage(
    catalogDisplayName: string,
    catalogId: string,
  ): AuthRequiredMcpToolError {
    const installUrl = `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_INSTALL_QUERY_PARAM}=${catalogId}`;
    return {
      type: "auth_required",
      message: formatActionableAuthError({
        title: `"${catalogDisplayName}" is not connected`,
        detail: `This tool's MCP connection has been uninstalled. Reconnect "${catalogDisplayName}" to use it.`,
        actionLabel: "reconnect the connection",
        url: installUrl,
        postAction: "Once reconnected, retry this tool call.",
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
  private async buildExpiredAuthMessage(params: {
    catalogDisplayName: string;
    catalogId: string;
    mcpServerId: string;
    tokenAuth?: TokenAuthContext;
    detailOverride?: string;
    // Pass the already-loaded install to avoid a redundant lookup when the
    // caller has resolved it (otherwise the scope is fetched by id).
    resolvedServer?: Pick<McpServer, "scope" | "teamId" | "ownerId">;
  }): Promise<AuthExpiredMcpToolError> {
    const {
      catalogDisplayName,
      catalogId,
      mcpServerId,
      tokenAuth,
      detailOverride,
      resolvedServer,
    } = params;
    const context = this.formatAuthContext(tokenAuth);
    const reauthUrl = `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_REAUTH_QUERY_PARAM}=${catalogId}&${MCP_CATALOG_SERVER_QUERY_PARAM}=${mcpServerId}`;
    const scope = await this.describeResolvedCredentialScope(
      mcpServerId,
      tokenAuth,
      resolvedServer,
    );
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
      credentialScope: scope?.credentialScope,
      credentialTeamName: scope?.credentialTeamName,
    };
  }

  /**
   * Describe which credential (personal / team / org) a resolved install
   * represents, plus the owning team's display name for team credentials, so
   * the re-authentication card can tell the user whose credential expired.
   * Mirrors the runtime resolution priority in {@link pickInstallForCaller}:
   * an org-scoped install is org-wide; anything bound to a team is a team
   * credential; everything else is a personal credential — but a personal
   * install is only reported as "personal" (the card says "Your personal
   * credentials …") when the caller actually owns it. Returns null when the
   * scope can't be attributed to the caller, so the card falls back to neutral
   * generic copy.
   */
  private async describeResolvedCredentialScope(
    mcpServerId: string,
    tokenAuth: TokenAuthContext | undefined,
    preloadedServer?: Pick<McpServer, "scope" | "teamId" | "ownerId">,
  ): Promise<{
    credentialScope: ResourceVisibilityScope;
    credentialTeamName: string | null;
  } | null> {
    let server = preloadedServer;
    if (!server) {
      const [loaded] = await McpServerModel.findByIdsBasic([mcpServerId]);
      server = loaded;
    }
    if (!server) {
      return null;
    }

    const executedAs = await this.describeInstallCredential(server);
    if (executedAs.kind === "org") {
      return { credentialScope: "org", credentialTeamName: null };
    }
    if (executedAs.kind === "team") {
      return {
        credentialScope: "team",
        credentialTeamName: executedAs.teamName,
      };
    }
    // Personal install. Only present it as the caller's own credential when the
    // caller owns it. A personal install resolved on behalf of another caller —
    // a catalog pinned to a service-account connection
    // (dynamicConnectionMcpServerId) or a retained static assignment — must not
    // be labeled "personal", or the card would falsely claim "Your personal
    // credentials …" and point the caller at the wrong owner.
    if (
      tokenAuth?.userId &&
      executedAs.ownerUserId &&
      tokenAuth.userId === executedAs.ownerUserId
    ) {
      return { credentialScope: "personal", credentialTeamName: null };
    }
    return null;
  }

  /**
   * Describe which identity the upstream call ran as, so the chat card and the
   * tool-call log record can answer "on whose behalf did this run?".
   *
   * The order mirrors how {@link getTransport} actually builds the outbound
   * credential header, not how the install was picked: an enterprise-managed
   * credential overrides the install's own secrets, and an external IdP token
   * is forwarded only when the install carries no stored authorization of its
   * own. Getting the order wrong would name the install's owner for a call
   * that really ran as the caller.
   */
  private async describeExecutedAs(params: {
    resolvedServer: ResolvedInstallIdentity | null;
    tokenAuth: TokenAuthContext | undefined;
    enterpriseTransportCredential: ResolvedEnterpriseTransportCredential | null;
    catalogItem: InternalMcpCatalog;
    secrets: Record<string, unknown>;
  }): Promise<McpExecutedAs | null> {
    const {
      resolvedServer,
      tokenAuth,
      enterpriseTransportCredential,
      catalogItem,
      secrets,
    } = params;

    // These three all mean "the calling user's own identity reached the
    // server", so they name that user rather than an installed connection.
    const callerUserId = tokenAuth?.userId ?? null;

    if (enterpriseTransportCredential) {
      return { kind: "idp_exchange", callerUserId };
    }

    if (!staticCredentialsProvideAuthorization({ catalogItem, secrets })) {
      if (tokenAuth?.isExternalIdp && tokenAuth.rawToken) {
        return { kind: "idp_passthrough", callerUserId };
      }
      if (hasPassthroughAuthorizationHeader(tokenAuth?.passthroughHeaders)) {
        return { kind: "caller_headers", callerUserId };
      }
    }

    return resolvedServer
      ? await this.describeInstallCredential(resolvedServer)
      : null;
  }

  /**
   * Map an install to the identity its stored credential belongs to. Shared by
   * the executed-as descriptor and the expired-credential card so both read
   * the install's scope the same way.
   */
  private async describeInstallCredential(
    server: Pick<McpServer, "scope" | "teamId" | "ownerId">,
  ): Promise<Extract<McpExecutedAs, { kind: "personal" | "team" | "org" }>> {
    if (server.scope === "org") {
      return { kind: "org" };
    }
    if (server.teamId) {
      const [team] = await TeamModel.findByIds([server.teamId]);
      return {
        kind: "team",
        teamId: server.teamId,
        teamName: team?.name ?? null,
      };
    }
    const ownerName = server.ownerId
      ? ((await UserModel.getNamesByIds([server.ownerId])).get(
          server.ownerId,
        ) ?? null)
      : null;
    return { kind: "personal", ownerUserId: server.ownerId, ownerName };
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
  private async persistToolCall(params: {
    owner: ToolOwner;
    mcpServerName: string;
    toolCall: CommonToolCall;
    toolResult: CommonToolResult;
    authInfo?: ToolCallAuthInfo;
    lockedChatContent?: ToolCallContentDisposition;
  }): Promise<void> {
    const { owner, mcpServerName, toolCall, toolResult, authInfo } = params;
    // Skip high-frequency browser tool logging to prevent DB bloat
    // (screenshots every ~2s, tab list checks, viewport resizes)
    if (isHighFrequencyBrowserTool(toolCall.name)) {
      return;
    }

    // Locked chat calls keep the tool name and owner/user metadata on the
    // audit surface either way; what differs is the content. With an audit
    // context the real arguments and result are handed to the model, which
    // encrypts them under the conversation key (never encrypt here — that
    // would nest envelopes). Without one there is no key that could ever open
    // them, so the row is redacted instead.
    const isLockedChat = params.lockedChatContent !== undefined;
    const audit =
      params.lockedChatContent?.kind === "encrypt"
        ? params.lockedChatContent.audit
        : null;
    const suppressContent = isLockedChat && audit === null;
    const storedToolCall: CommonToolCall = suppressContent
      ? {
          id: toolCall.id,
          name: toolCall.name,
          arguments: LOCKED_CHAT_REDACTED_MARKER,
        }
      : toolCall;
    const storedToolResult: unknown = suppressContent
      ? LOCKED_CHAT_REDACTED_MARKER
      : toolResult;

    try {
      const savedToolCall = await McpToolCallModel.create(
        {
          ownerType: owner.type,
          agentId: owner.type === "agent" ? owner.id : null,
          appId: owner.type === "app" ? owner.id : null,
          mcpServerName,
          method: "tools/call",
          toolCall: storedToolCall,
          toolResult: storedToolResult,
          userId: authInfo?.userId ?? null,
          executionId: authInfo?.executionId ?? null,
          authMethod: authInfo?.authMethod ?? null,
        },
        audit,
      );

      const logData: {
        id: string;
        toolName: string;
        error?: string;
        resultContent?: string;
      } = {
        id: savedToolCall.id,
        toolName: toolCall.name,
      };

      // The app log stays content-free for every locked-chat call, encrypted
      // rows included: the row is protected at rest, the log line is not.
      if (isLockedChat) {
        logData.resultContent = "[redacted: locked chat]";
      } else if (toolResult.isError) {
        // Tool errors routinely echo request/response payloads — cap them
        // the same way as the success-path content preview.
        logData.error = toolResult.error?.slice(0, 100);
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
    /**
     * Credential resolved from the catalog's enterprise-managed config, already
     * mapped onto the header its injection mode asks for. Passing the raw token
     * as a `secrets.access_token` instead would force `Authorization: Bearer`
     * and ignore a configured custom header.
     */
    enterpriseTransportCredential?: ResolvedEnterpriseTransportCredential;
  }): Promise<CommonMcpToolDefinition[]> {
    const {
      catalogItem,
      mcpServerId,
      secrets,
      secretId,
      enterpriseTransportCredential,
    } = params;

    // Local stdio servers can report a ready pod before the MCP process accepts
    // JSON-RPC, especially while the runtime is still pulling or starting Node.
    const maxRetries = catalogItem.serverType === "local" ? 6 : 1;
    const retryDelayMs = 5000; // 5 seconds between retries

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let client: Client | undefined;
      try {
        // Get the appropriate transport using the existing helper
        const transport = await this.getTransport(
          catalogItem,
          mcpServerId,
          secrets,
          secretId,
          undefined,
          undefined,
          enterpriseTransportCredential ?? undefined,
        );

        // No `roots` — see the identical omission above.
        const capabilities: ClientCapabilitiesWithExtensions = {
          extensions: mcpClientExtensionCapabilities(),
        };

        // Create client with transport
        client = new Client(buildMcpClientInfo("archestra-platform"), {
          capabilities,
        });
        const serverExtensions = captureServerExtensions(transport);

        // Connect with timeout
        await this.raceWithTimeout(
          client.connect(transport),
          30000,
          "Connection timeout after 30 seconds",
        );

        // List tools with timeout. Some MCP servers expose only resources; for
        // those, synthesize read-resource tools so agents can still exercise the
        // server through the normal tool-assignment path.
        let tools: Tool[];
        try {
          tools = await this.discoverToolsOrResourceTools(client);
        } catch (error) {
          // A Skills-only server may intentionally expose neither tools/list
          // nor resources/list. Its declared extension is enough to keep the
          // installation; the companion metadata pass will call skills/list.
          if (
            config.mcpGateway.skillsEnabled &&
            Object.hasOwn(serverExtensions(), MCP_SKILLS_EXTENSION_ID)
          ) {
            tools = [];
          } else {
            throw error;
          }
        }

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

        // Only the success path closed the client; a failure after connect
        // (e.g. tool discovery threw) would otherwise leak its transport.
        if (client) {
          try {
            await client.close();
          } catch (closeError) {
            logger.warn(
              { closeError, server: catalogItem.name },
              "Error closing MCP client after failed tool discovery (non-fatal)",
            );
          }
        }

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
        throw new McpServerUnreachableError(
          `Failed to connect to MCP server ${catalogItem.name}: ${lastError.message}`,
        );
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new McpServerUnreachableError(
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
    /**
     * Credential resolved from the catalog's enterprise-managed config, already
     * mapped onto the header its injection mode asks for. The inspector reaches
     * the same upstream as a tool call, so it must present the same credential.
     */
    enterpriseTransportCredential?: ResolvedEnterpriseTransportCredential;
  }): Promise<unknown> {
    const {
      catalogItem,
      mcpServerId,
      secrets,
      method,
      enterpriseTransportCredential,
    } = params;

    const runInspection = async (): Promise<unknown> => {
      const transport = await this.getTransport(
        catalogItem,
        mcpServerId,
        secrets,
        undefined,
        undefined,
        undefined,
        enterpriseTransportCredential,
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
          client.callTool(
            {
              name: params.toolName,
              arguments: params.toolArguments ?? {},
            },
            undefined,
            { timeout: config.mcpGateway.toolCallTimeoutMs },
          ),
          config.mcpGateway.toolCallTimeoutMs,
          "Tool call timeout",
        );
      } finally {
        await client.close().catch(() => {});
      }
    };

    const inspectWithStaleSessionRetry = async (): Promise<unknown> => {
      try {
        return await runInspection();
      } catch (error) {
        // The upstream dropped the session between connecting and the call.
        // Tool calls recover from this transparently (see executeToolCall);
        // inspection used to surface it to the operator as a failed server,
        // which reads as "this server is broken" for what a second attempt
        // resolves. Build a fresh transport and try once more.
        if (!isStaleSessionError(error)) {
          throw error;
        }
        logger.info(
          { mcpServerId, method },
          "Stale session during MCP inspection, retrying with a fresh session",
        );
        return await runInspection();
      }
    };

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (catalogItem.serverType === "local") {
      return mcpActiveUseTracker.trackActiveUse(mcpServerId, async () => {
        await McpServerRuntimeManager.ensureAwake(mcpServerId);
        return inspectWithStaleSessionRetry();
      });
    }
    // SPDX-SnippetEnd
    return inspectWithStaleSessionRetry();
  }

  /**
   * Connect directly to ONE installed server by id with its own credentials,
   * run a single operation, then close. Powers the server-scoped Apps run path
   * (POST /api/mcp/server/:id), which has no agent/owner context — access is
   * gated by the route (mcpServerInstallation:read) before this is reached. No
   * OAuth auto-refresh (adequate for UI-providing servers, typically no/PAT
   * auth); a future catalog-scoped path can add it.
   */
  private async withDirectServerClient<T>(
    mcpServerId: string,
    run: (client: Client, session: DirectServerSession) => Promise<T>,
    options?: {
      clientName?: string;
      capabilities?: ClientCapabilitiesWithExtensions;
      owner?: ToolOwner;
      tokenAuth?: TokenAuthContext;
      enterpriseTransportCredential?: ResolvedEnterpriseTransportCredential;
    },
  ): Promise<T> {
    const [server] = await McpServerModel.findByIdsBasic([mcpServerId]);
    if (!server) {
      throw new Error(`MCP server not found: ${mcpServerId}`);
    }
    if (!server.catalogId) {
      throw new Error(`MCP server ${mcpServerId} has no catalog`);
    }
    const catalogItem = await InternalMcpCatalogModel.findById(
      server.catalogId,
    );
    if (!catalogItem) {
      throw new Error(`Catalog not found for MCP server ${mcpServerId}`);
    }
    const runWithClient = async (): Promise<T> => {
      const { secrets } = await this.fetchSecretsForLoadedMcpServer({
        id: mcpServerId,
        secretId: server.secretId,
      });
      const enterpriseTransportCredential =
        options?.enterpriseTransportCredential ??
        (options?.owner
          ? await this.resolveCachedEnterpriseTransportCredential({
              owner: options.owner,
              tokenAuth: options.tokenAuth,
              enterpriseManagedConfig: catalogItem.enterpriseManagedConfig,
            })
          : null);
      const transport = await this.getTransport(
        catalogItem,
        mcpServerId,
        secrets,
        server.secretId ?? undefined,
        undefined,
        options?.tokenAuth,
        enterpriseTransportCredential ?? undefined,
      );
      const client = new Client(
        buildMcpClientInfo(options?.clientName ?? "archestra-app-runner"),
        { capabilities: options?.capabilities ?? {} },
      );
      const serverExtensions = captureServerExtensions(transport);
      try {
        await this.raceWithTimeout(
          client.connect(transport),
          30000,
          new McpServerConnectionTimeoutError(),
        );
        return await run(client, { serverExtensions });
      } finally {
        await client.close().catch(() => {});
      }
    };

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (catalogItem.serverType === "local") {
      return mcpActiveUseTracker.trackActiveUse(mcpServerId, async () => {
        await McpServerRuntimeManager.ensureAwake(mcpServerId);
        return runWithClient();
      });
    }
    // SPDX-SnippetEnd
    return runWithClient();
  }

  /** Fresh source-scoped session for Skills discovery and live reads. */
  async withSkillsSession<T>(params: {
    mcpServerId: string;
    run: (client: Client, session: DirectServerSession) => Promise<T>;
    owner?: ToolOwner;
    tokenAuth?: TokenAuthContext;
    enterpriseTransportCredential?: ResolvedEnterpriseTransportCredential;
  }): Promise<T> {
    return this.withDirectServerClient(params.mcpServerId, params.run, {
      clientName: "archestra-skills-client",
      capabilities: {
        extensions: MCP_SKILLS_CLIENT_EXTENSION_CAPABILITIES,
      },
      owner: params.owner,
      tokenAuth: params.tokenAuth,
      enterpriseTransportCredential: params.enterpriseTransportCredential,
    });
  }

  /** Read a UI (`ui://`) resource directly from one installed server. */
  async readResourceForServer(params: {
    mcpServerId: string;
    uri: string;
  }): Promise<unknown> {
    return this.retryTransientResourceRead({
      uri: params.uri,
      mcpServerId: params.mcpServerId,
      read: () =>
        this.withDirectServerClient(params.mcpServerId, (client) =>
          this.raceWithTimeout(
            client.readResource({ uri: params.uri }),
            30000,
            "Read resource timeout",
          ),
        ),
    });
  }

  /** Call a tool directly on one installed server (server-scoped run path). */
  async callToolForServer(params: {
    mcpServerId: string;
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown> {
    return this.withDirectServerClient(params.mcpServerId, (client) =>
      this.raceWithTimeout(
        client.callTool(
          {
            name: params.name,
            arguments: params.arguments ?? {},
          },
          undefined,
          { timeout: config.mcpGateway.toolCallTimeoutMs },
        ),
        config.mcpGateway.toolCallTimeoutMs,
        "Tool call timeout",
      ),
    );
  }

  /**
   * Disconnect from all MCP servers
   */
  async disconnectAll(): Promise<void> {
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

    await Promise.all(activeDisconnectPromises);
    this.clearAllConnectionState();
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

        this.clearConnectionState(connectionKey);
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
    // An app resource (ui://archestra-app/<appId>) is served in-process from the
    // app store — there is no upstream server to read it from. The URI carries
    // the app id, so authorize against the APP's own visibility (the caller must
    // be able to view it), not against whether some assigned tool advertises the
    // URI — a malicious upstream server could otherwise claim a victim app's
    // ui:// id in its tool _meta and read that app's HTML. An unauthorized or
    // unknown URI falls through to the normal path, which returns not-found (no
    // existence leak). Dynamic import avoids a static cycle with
    // mcp-app-gateway.utils (which imports this client).
    const appResourcePrefix = getArchestraAppResourceUri("");
    if (tokenAuth?.userId && tokenAuth.organizationId) {
      const appId = uri.startsWith(appResourcePrefix)
        ? uri.slice(appResourcePrefix.length)
        : "";
      // A malformed (non-UUID) id would make the UUID-typed lookup below throw
      // ("invalid input syntax for type uuid") and surface as a 500; treat it as
      // a normal not-found instead.
      if (
        appId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          appId,
        )
      ) {
        const { callerIsAppAdmin } = await import(
          "@/services/apps/app-authorization"
        );
        const app = await AppModel.findByIdForCaller({
          id: appId,
          organizationId: tokenAuth.organizationId,
          userId: tokenAuth.userId,
          isAppAdmin: await callerIsAppAdmin(
            tokenAuth.userId,
            tokenAuth.organizationId,
          ),
        });
        if (app) {
          const { buildAppUiResource } = await import(
            "@/routes/mcp-app-gateway.utils"
          );
          return buildAppUiResource(appId, uri, tokenAuth);
        }
      }
    }

    // Per-agent exclusions (Auto-tool mode): when exclusions exist, resolve
    // the resource's backing tool/server identity BEFORE consulting the cache
    // — a previously cached resource from a newly excluded catalog must not be
    // served from cache. The exclusion-filtered resolution returning null
    // means the resource is unreachable for this agent. Empty exclusions skip
    // this entirely (zero behavior change).
    const exclusionSets =
      await agentToolExclusionsService.getActiveExclusionSets(agentId);
    let preResolvedServer: {
      server: NonNullable<Awaited<ReturnType<typeof McpServerModel.findById>>>;
      catalogItem: NonNullable<
        Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>
      >;
    } | null = null;
    if (hasAnyExclusions(exclusionSets)) {
      preResolvedServer = await this.findMcpServerForResource(
        uri,
        agentId,
        tokenAuth,
        exclusionSets,
      );
      if (!preResolvedServer) {
        throw new Error(
          `Resource not found or no server could read it: ${uri}`,
        );
      }
    }

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

    const mcpServer =
      preResolvedServer ??
      (await this.findMcpServerForResource(
        uri,
        agentId,
        tokenAuth,
        exclusionSets,
      ));

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
      const result = await this.doReadResourceWithRetry({
        uri,
        agentId,
        mcpServer,
        tokenAuth,
      });
      this.resourceCache.set(cacheKey, {
        result,
        ttl: Date.now() + RESOURCE_CACHE_TTL_MS,
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

  private async doReadResourceWithRetry(params: {
    uri: string;
    agentId: string;
    mcpServer: {
      server: NonNullable<Awaited<ReturnType<typeof McpServerModel.findById>>>;
      catalogItem: NonNullable<
        Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>
      >;
    };
    tokenAuth?: TokenAuthContext;
  }): Promise<ResourceContents> {
    return this.retryTransientResourceRead({
      uri: params.uri,
      mcpServerId: params.mcpServer.server.id,
      read: () =>
        this.doReadResource(
          params.uri,
          params.agentId,
          params.mcpServer,
          params.tokenAuth,
        ),
      resetConnection: () =>
        this.invalidateConnectionsForServer(params.mcpServer.server.id),
    });
  }

  private async retryTransientResourceRead<T>(params: {
    uri: string;
    mcpServerId: string;
    read: () => Promise<T>;
    resetConnection?: () => Promise<void>;
  }): Promise<T> {
    let deadlineAt: number | undefined;

    for (let attempt = 1; ; attempt++) {
      try {
        return await params.read();
      } catch (error) {
        const exhausted = attempt >= RESOURCE_READ_RETRY_MAX_ATTEMPTS;
        if (exhausted || !isTransientResourceReadError(error)) {
          throw error;
        }

        // A direct read includes the managed wake. Start the retry deadline at
        // the first transient transport failure, not before the wake; otherwise
        // any cold start longer than the retry window disables retries entirely.
        deadlineAt ??= Date.now() + RESOURCE_READ_RETRY_DEADLINE_MS;
        if (Date.now() >= deadlineAt) throw error;

        // Cached clients must not reuse the transport or HTTP session that
        // failed. Direct reads create and close a fresh client per attempt.
        await params.resetConnection?.();

        const backoffCeilingMs = Math.min(
          RESOURCE_READ_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          RESOURCE_READ_RETRY_MAX_DELAY_MS,
        );
        // Equal jitter keeps retries spread out while retaining enough minimum
        // delay to cover bounded service/endpoint propagation after a wake.
        const backoffFloorMs = Math.floor(backoffCeilingMs / 2);
        const jitteredDelayMs =
          backoffFloorMs +
          Math.floor(Math.random() * (backoffCeilingMs - backoffFloorMs + 1));
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) throw error;
        const delayMs = Math.min(jitteredDelayMs, remainingMs);

        logger.warn(
          {
            err: error,
            uri: params.uri,
            mcpServerId: params.mcpServerId,
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
          },
          "Transient MCP resource read failed; reconnecting and retrying",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * The concrete install (mcp_server id) that serves an MCP App `ui://` resource
   * for this caller, so the chat MCP-App enrichment can stamp it onto
   * `_meta.ui.mcpServerId` and bind an agent-driven external-app render's
   * callbacks to `/api/mcp/server/:id` — matching the seeded open-in-chat path
   * (buildExternalAppRenderResult), whose absence otherwise misroutes the app's
   * `callServerTool` to the agent gateway.
   *
   * Binds to the same install run_tool executes against, for any number of
   * installs: a valid service-account pin (`dynamicConnectionMcpServerId`)
   * routes every caller to one install; otherwise the caller's own→team→org
   * connection policy resolves it (`findMcpServerForResource`), so a
   * per-user-credentialed catalog binds each caller to their own install.
   *
   * Returns null (render stays unbound, callbacks fail cleanly rather than
   * misrouting) when the caller has no accessible install for the resource, the
   * resource is an owned-app backing (`serverType === "app"`, rendered by app id
   * via render_app), or the catalog is enterprise-managed with more than one
   * install — enterprise credentials resolve the runtime install by their own
   * mechanism, which can pick a different install than the own→team→org policy.
   */
  async resolveUiAppInstallIdForCaller(
    resourceUri: string,
    agentId: string,
    tokenAuth?: TokenAuthContext,
  ): Promise<string | null> {
    const resolved = await this.findMcpServerForResource(
      resourceUri,
      agentId,
      tokenAuth,
    );
    if (!resolved || resolved.catalogItem.serverType === "app") {
      return null;
    }
    const { catalogItem } = resolved;
    const pinnedId = catalogItem.dynamicConnectionMcpServerId;
    const enterpriseManaged = catalogItem.enterpriseManagedConfig != null;
    if (pinnedId || enterpriseManaged) {
      const installs = await McpServerModel.findByCatalogId(catalogItem.id);
      // A valid service-account pin routes every caller through one install.
      if (pinnedId && installs.some((server) => server.id === pinnedId)) {
        return pinnedId;
      }
      // Enterprise-managed credentials resolve the runtime install by their own
      // mechanism (an explicit pin or the first install), which can diverge from
      // the own→team→org resolution when the catalog has more than one install —
      // a single install cannot diverge. Decline rather than bind callbacks to
      // an install run_tool did not execute against.
      if (enterpriseManaged && installs.length > 1) {
        return null;
      }
    }
    return resolved.server.id;
  }

  private async findMcpServerForResource(
    uri: string,
    agentId: string,
    tokenAuth?: TokenAuthContext,
    exclusionSets?: AgentToolExclusionSets,
  ): Promise<{
    server: NonNullable<Awaited<ReturnType<typeof McpServerModel.findById>>>;
    catalogItem: NonNullable<
      Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>
    >;
  } | null> {
    // Per-agent exclusions (Auto-tool mode): an excluded backing tool must not
    // resolve the resource to its server. Callers on the read path pass the
    // sets they already loaded; the background-refresh path loads them here.
    const effectiveExclusions =
      exclusionSets ??
      (await agentToolExclusionsService.getActiveExclusionSets(agentId));
    const matchingTools = (
      await ToolModel.findToolsByUiResourceUri(agentId, uri)
    ).filter((match) => !isToolRowExcluded(match.tool, effectiveExclusions));
    let catalogId = matchingTools[0]?.catalogId ?? null;

    // Assignment miss: a tool the agent reaches only through dynamic access
    // ("all tools" mode) has no agent_tools row, so its resource is invisible to
    // the assignment-scoped lookup above. Fall back to the same user-scoped
    // resolution run_tool uses — otherwise the MCP App fails to load its HTML
    // even though the tool ran. Dynamic import avoids a static cycle with
    // archestra-mcp-server (which reaches this client through run_tool).
    if (!catalogId && tokenAuth?.userId && tokenAuth.organizationId) {
      const { resolveDynamicToolByUiResource } = await import(
        "@/archestra-mcp-server/dynamic-tools"
      );
      const dynamicTool = await resolveDynamicToolByUiResource({
        resourceUri: uri,
        agentId,
        userId: tokenAuth.userId,
        organizationId: tokenAuth.organizationId,
      });
      catalogId = dynamicTool?.catalogId ?? null;
    }

    if (catalogId) {
      const catalogItem = await InternalMcpCatalogModel.findById(catalogId);
      if (catalogItem) {
        const servers = await McpServerModel.findByCatalogId(catalogId);
        // Select the install the caller can actually reach (own → team → org),
        // the same connection policy tool execution uses — never another user's
        // personal install of a shared catalog, whose secrets this read would
        // otherwise connect with. Fail closed when the caller has no accessible
        // install rather than falling back to an arbitrary one.
        const server = await this.pickInstallForCaller(servers, tokenAuth);
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
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    options?: { wake?: boolean },
    // SPDX-SnippetEnd
  ): Promise<ResourceContents> {
    const { server, catalogItem } = mcpServer;

    const readFromServer = async (): Promise<ResourceContents> => {
      const secretResult = await this.getSecretsForMcpServer({
        targetMcpServerId: server.id,
        toolCall: { id: "resource-read", name: "read", arguments: {} },
        owner: agentOwner(agentId),
      });

      if ("error" in secretResult) {
        throw new Error(`Secret resolution failed: ${secretResult.error}`);
      }
      const { secrets, secretId } = secretResult;

      // Resource reads hit the same upstream as tool calls, so they must carry
      // the same enterprise-managed credential. Without it the transport falls
      // back to forwarding the caller's raw IdP token as `Authorization: Bearer`,
      // bypassing the catalog's configured injection mode entirely.
      const enterpriseTransportCredential = catalogItem.enterpriseManagedConfig
        ? await this.resolveCachedEnterpriseTransportCredential({
            owner: agentOwner(agentId),
            tokenAuth,
            enterpriseManagedConfig: catalogItem.enterpriseManagedConfig,
          })
        : null;
      if (
        catalogItem.enterpriseManagedConfig &&
        !enterpriseTransportCredential
      ) {
        throw new Error(
          `Enterprise-managed credential could not be resolved for ${catalogItem.name}`,
        );
      }

      const transport = await this.getTransport(
        catalogItem,
        server.id,
        secrets,
        secretId,
        undefined,
        tokenAuth,
        enterpriseTransportCredential ?? undefined,
      );
      const connectionKey = `${catalogItem.id}:${server.id}:${agentId}`;
      const client = await this.getOrCreateClient(
        connectionKey,
        transport,
        server.id,
        secretResult.serverState,
      );

      return await client.readResource({ uri });
    };

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (catalogItem.serverType === "local") {
      if (options?.wake !== false) {
        return mcpActiveUseTracker.trackActiveUse(server.id, async () => {
          await McpServerRuntimeManager.ensureAwake(server.id);
          return readFromServer();
        });
      }
      const passiveRead = await McpServerRuntimeManager.runIfDeploymentServing(
        server.id,
        readFromServer,
      );
      if (!passiveRead.ran) {
        throw new McpServerNotReadyError(
          `MCP server ${server.name} is dormant; passive resource refresh skipped`,
        );
      }
      return passiveRead.value;
    }
    // SPDX-SnippetEnd
    return readFromServer();
  }

  private async refreshResourceInBackground(
    uri: string,
    agentId: string,
    _tokenAuth: TokenAuthContext | undefined,
    cacheKey: string,
    _currentResult: ResourceContents,
  ): Promise<void> {
    try {
      const mcpServer = await this.findMcpServerForResource(
        uri,
        agentId,
        _tokenAuth,
      );
      if (!mcpServer) {
        logger.debug(
          { uri, agentId },
          "readResource: Background refresh - no server found",
        );
        return;
      }

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // Cache maintenance is passive: never wake an otherwise idle server.
      if (
        mcpServer.catalogItem.serverType === "local" &&
        McpServerRuntimeManager.isDeploymentDormant(mcpServer.server.id)
      ) {
        logger.debug(
          { uri, agentId, serverId: mcpServer.server.id },
          "readResource: Skipping background refresh for dormant MCP server",
        );
        return;
      }
      // SPDX-SnippetEnd

      const newResult = await this.doReadResource(
        uri,
        agentId,
        mcpServer,
        _tokenAuth,
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        { wake: false },
        // SPDX-SnippetEnd
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
  private async getClientsForAgent(
    agentId: string,
    tokenAuth?: TokenAuthContext,
    exclusionSets?: AgentToolExclusionSets,
  ): Promise<PassiveMcpClient[]> {
    // Per-agent exclusions (Auto-tool mode): an excluded catalog/tool must not
    // make its upstream server reachable via resources/prompts listing. A
    // catalog stays reachable while it has at least one non-excluded assigned
    // tool (the list handlers then filter that catalog's listings down to the
    // excluded tools' resource URIs). Callers pass the sets they already
    // loaded; loaded here otherwise. Empty (no-op) unless the agent's
    // accessAllTools setting is on.
    const { tools, exclusionSets: effectiveExclusions } =
      await agentToolExclusionsService.getFilteredMcpToolsByAgent(
        agentId,
        exclusionSets,
      );
    const assignedTools = await ToolModel.getMcpToolsAssignedToAgent(
      tools.map((tool) => tool.name),
      agentId,
    );
    const toolsByCatalogId = new Map<string, McpToolAssignment>();
    for (const tool of assignedTools) {
      if (
        tool.catalogId &&
        !toolsByCatalogId.has(tool.catalogId) &&
        !isToolIdentityExcluded(
          { catalogId: tool.catalogId, name: tool.toolName },
          effectiveExclusions,
        )
      ) {
        toolsByCatalogId.set(tool.catalogId, tool);
      }
    }

    const clients: PassiveMcpClient[] = [];

    for (const [catalogId, tool] of toolsByCatalogId) {
      try {
        const catalogItem = await InternalMcpCatalogModel.findById(catalogId);
        if (!catalogItem) continue;

        const targetResult =
          await this.determineTargetMcpServerIdForCatalogItem({
            tool,
            tokenAuth,
            toolCall: {
              id: "list-op",
              name: tool.toolName,
              arguments: {},
            },
            owner: agentOwner(agentId),
            catalogItem,
          });
        if ("error" in targetResult) continue;

        const { targetMcpServerId } = targetResult;
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        // Pooled resource/prompt listings are passive reads. Do not wake a
        // dormant server or stamp an awake one, otherwise polling keeps every
        // assigned deployment alive forever.
        if (
          catalogItem.serverType === "local" &&
          McpServerRuntimeManager.isDeploymentDormant(targetMcpServerId)
        ) {
          logger.debug(
            { agentId, catalogId, targetMcpServerId },
            "Skipping dormant MCP server in list operation",
          );
          continue;
        }
        // SPDX-SnippetEnd
        // Catalog-level enterprise-managed config is authoritative — see
        // executeToolCall for why stale assignment modes are overridden.
        const usesEnterpriseManagedCredential =
          tool.credentialResolutionMode === "enterprise_managed" ||
          catalogItem.enterpriseManagedConfig != null;
        const enterpriseTransportCredential = usesEnterpriseManagedCredential
          ? await this.resolveCachedEnterpriseTransportCredential({
              owner: agentOwner(agentId),
              tokenAuth,
              enterpriseManagedConfig:
                catalogItem.enterpriseManagedConfig ?? null,
            })
          : null;
        if (usesEnterpriseManagedCredential && !enterpriseTransportCredential) {
          continue;
        }

        const secretResult = await this.getSecretsForMcpServer({
          targetMcpServerId,
          toolCall: { id: "list-op", name: tool.toolName, arguments: {} },
          owner: agentOwner(agentId),
        });
        if ("error" in secretResult) continue;

        const externalIdpUserId = tokenAuth?.isExternalIdp
          ? tokenAuth.userId
          : undefined;
        let connectionKey = `${catalogItem.id}:${targetMcpServerId}`;
        if (externalIdpUserId) {
          connectionKey = `${connectionKey}:ext:${externalIdpUserId}`;
        }
        clients.push({
          execute: async <T>(operation: (client: Client) => Promise<T>) => {
            const connectAndRun = async () => {
              const transport = await this.getTransport(
                catalogItem,
                targetMcpServerId,
                secretResult.secrets,
                secretResult.secretId,
                connectionKey,
                tokenAuth,
                enterpriseTransportCredential ?? undefined,
              );
              const client = await this.getOrCreateClient(
                connectionKey,
                transport,
                targetMcpServerId,
                secretResult.serverState,
              );
              return operation(client);
            };
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            if (catalogItem.serverType === "local") {
              return McpServerRuntimeManager.runIfDeploymentServing(
                targetMcpServerId,
                connectAndRun,
              );
            }
            // SPDX-SnippetEnd
            return { ran: true, value: await connectAndRun() };
          },
        });
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
    tokenAuth?: TokenAuthContext,
  ): Promise<{ resources: Array<Record<string, unknown>> }> {
    const exclusionSets =
      await agentToolExclusionsService.getActiveExclusionSets(agentId);
    const clients = await this.getClientsForAgent(
      agentId,
      tokenAuth,
      exclusionSets,
    );
    const allResources: Array<Record<string, unknown>> = [];

    await Promise.all(
      clients.map(async (client) => {
        try {
          const execution = await client.execute((upstream) =>
            upstream.listResources(),
          );
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          if (!execution.ran) return;
          // SPDX-SnippetEnd
          const result = execution.value;
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

    // Per-agent exclusions (Auto-tool mode): a catalog can stay reachable
    // through a non-excluded sibling tool, so drop the resources attributable
    // to an excluded tool (the same ui-resource-uri ↔ tool attribution
    // readResource enforces). Resources not attributable to any excluded tool
    // stay.
    return {
      resources: allResources.filter(
        (resource) =>
          typeof resource.uri !== "string" ||
          !exclusionSets.resourceUris.has(resource.uri),
      ),
    };
  }

  /**
   * List resource templates from all upstream MCP servers connected to an agent.
   */
  async listResourceTemplates(
    agentId: string,
    tokenAuth?: TokenAuthContext,
  ): Promise<{ resourceTemplates: Array<Record<string, unknown>> }> {
    const exclusionSets =
      await agentToolExclusionsService.getActiveExclusionSets(agentId);
    const clients = await this.getClientsForAgent(
      agentId,
      tokenAuth,
      exclusionSets,
    );
    const allTemplates: Array<Record<string, unknown>> = [];

    await Promise.all(
      clients.map(async (client) => {
        try {
          const execution = await client.execute((upstream) =>
            upstream.listResourceTemplates(),
          );
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          if (!execution.ran) return;
          // SPDX-SnippetEnd
          const result = execution.value;
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

    // Same attribution filter as listResources: templates whose uriTemplate
    // (or uri) matches an excluded tool's declared resource URI are dropped.
    return {
      resourceTemplates: allTemplates.filter((template) => {
        const uris = [template.uriTemplate, template.uri].filter(
          (value): value is string => typeof value === "string",
        );
        return !uris.some((uri) => exclusionSets.resourceUris.has(uri));
      }),
    };
  }

  /**
   * List prompts from all upstream MCP servers connected to an agent.
   */
  async listPrompts(
    agentId: string,
    tokenAuth?: TokenAuthContext,
  ): Promise<{ prompts: Array<Record<string, unknown>> }> {
    const clients = await this.getClientsForAgent(agentId, tokenAuth);
    // Prompts have no per-tool attribution (tool meta declares resource URIs,
    // not prompt names), so they are only implicitly filtered by which upstream
    // servers getClientsForAgent connects — a server whose tools are all
    // excluded is not connected, so its prompts never surface.
    const allPrompts: Array<Record<string, unknown>> = [];

    await Promise.all(
      clients.map(async (client) => {
        try {
          const execution = await client.execute((upstream) =>
            upstream.listPrompts(),
          );
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          if (!execution.ran) return;
          // SPDX-SnippetEnd
          const result = execution.value;
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
    owner: ToolOwner;
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
    owner: ToolOwner;
    tokenAuth?: TokenAuthContext;
    enterpriseManagedConfig: EnterpriseManagedCredentialConfig | null;
  }): string | null {
    if (!params.enterpriseManagedConfig || !params.tokenAuth) {
      return null;
    }

    return JSON.stringify({
      ownerType: params.owner.type,
      ownerId: params.owner.id,
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
    return (
      left.secretId === right.secretId &&
      left.credentialFingerprint === right.credentialFingerprint
    );
  }

  private toCachedServerState(mcpServer: {
    secretId: string | null;
  }): CachedServerState {
    return {
      secretId: mcpServer.secretId ?? null,
      credentialFingerprint: null,
    };
  }

  private trackTransportCredentialFingerprint(
    connectionKey: string | undefined,
    headers: Record<string, string>,
  ): void {
    if (!connectionKey) {
      return;
    }

    this.latestTransportCredentialFingerprints.set(
      connectionKey,
      fingerprintHeaders(headers),
    );
  }

  private withLatestCredentialFingerprint(
    connectionKey: string,
    serverState: CachedServerState,
  ): CachedServerState {
    return {
      ...serverState,
      credentialFingerprint:
        this.latestTransportCredentialFingerprints.get(connectionKey) ?? null,
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

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
async function waitForMcpServerWake(params: {
  mcpServerId: string;
  mcpServerName: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  if (params.abortSignal?.aborted) {
    throw params.abortSignal.reason instanceof Error
      ? params.abortSignal.reason
      : new Error("The tool call was aborted before the wake");
  }
  const budgetMs = wakeResponseBudgetMs();
  const wake = withDeadline(
    McpServerRuntimeManager.ensureAwake(params.mcpServerId),
    budgetMs,
    () => new McpServerWakePendingError(params.mcpServerName, budgetMs),
  );
  if (!params.abortSignal) {
    await wake;
    return;
  }

  const { abortSignal } = params;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(
        abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error("The tool call was aborted during the wake"),
      );
    };
    if (abortSignal.aborted) {
      onAbort();
      return;
    }
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    await Promise.race([wake, aborted]);
  } finally {
    if (onAbort) abortSignal.removeEventListener("abort", onAbort);
  }
}

function describeWakeFailure(
  error: unknown,
  mcpServerName: string,
): { agentMessage: string; unexpected: boolean } {
  if (error instanceof McpServerWakeError) {
    return { agentMessage: error.message, unexpected: false };
  }
  if (error instanceof McpServerDeploymentFailedError) {
    return {
      agentMessage: `MCP server ${mcpServerName} cannot start, and retrying will not help until its image or configuration is fixed - edit or reinstall it from the registry. ${deploymentFailureCause(error.message)}`,
      unexpected: false,
    };
  }
  return {
    agentMessage: `MCP server ${mcpServerName} could not be woken from idle hibernation: the platform failed to complete the wake. This is not a problem with the tool call - retrying may work, and an administrator can see the full failure in the platform logs.`,
    unexpected: true,
  };
}

function deploymentFailureCause(message: string): string {
  return message.replace(/^Deployment \S+ failed: /, "");
}
// SPDX-SnippetEnd

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

// Whether the caller's own request supplied the upstream authorization header,
// which the transport forwards verbatim (mergePassthroughHeaders only fills
// headers the install itself did not set) — so the call runs as the caller.
function hasPassthroughAuthorizationHeader(
  passthroughHeaders: Record<string, string> | undefined,
): boolean {
  if (!passthroughHeaders) {
    return false;
  }
  return Object.keys(passthroughHeaders).some(
    (name) => name.toLowerCase() === "authorization",
  );
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

/**
 * True when the install's stored static credentials already settle the
 * outbound authorization — either via the canonical token secret fields, or
 * via a custom userConfig field mapped to the `Authorization` header. The
 * external-IdP JWT fallback (end-to-end JWKS pattern) must never fire in that
 * case: it would overwrite a working stored credential with the caller's JWT
 * and the upstream would reject the call.
 */
function staticCredentialsProvideAuthorization(params: {
  catalogItem: InternalMcpCatalog;
  secrets: Record<string, unknown>;
}): boolean {
  if (hasStaticAuthorizationCredential(params.secrets)) {
    return true;
  }

  return Object.keys(buildStaticCredentialHeaders(params)).some(
    (name) => name.toLowerCase() === "authorization",
  );
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

/**
 * Apply an enterprise-managed credential as the outbound auth header, dropping
 * any `Authorization` the install's own static secrets already contributed.
 *
 * The enterprise exchange is authoritative once it runs, so a leftover
 * `Authorization` from a stale `access_token` must not ride along: when the
 * catalog injects into a custom header the upstream would otherwise receive
 * two credentials and typically authenticate as the stale one.
 */
function applyEnterpriseCredentialHeader(
  headers: Record<string, string>,
  credential: { headerName: string; headerValue: string },
): void {
  if (credential.headerName.toLowerCase() !== "authorization") {
    for (const headerName of Object.keys(headers)) {
      if (headerName.toLowerCase() === "authorization") {
        delete headers[headerName];
      }
    }
  }

  headers[credential.headerName] = credential.headerValue;
}

function mcpClientExtensionCapabilities() {
  return {
    ...MCP_APPS_CLIENT_EXTENSION_CAPABILITIES,
    ...MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
    ...(config.mcpGateway.skillsEnabled
      ? MCP_SKILLS_CLIENT_EXTENSION_CAPABILITIES
      : {}),
  } as const;
}

function resolveContentDisposition(
  options?: ExecuteToolCallForOwnerOptions,
): ToolCallContentDisposition | undefined {
  if (!options?.suppressContentLogging) return undefined;
  return options.lockedChatAudit
    ? { kind: "encrypt", audit: options.lockedChatAudit }
    : { kind: "redact" };
}

function buildDefaultAuthorizationHeaders(
  headers: Record<string, string>,
  secrets: Record<string, unknown>,
): Record<string, string> {
  const hasAuthorizationHeader = Object.keys(headers).some(
    (headerName) => headerName.toLowerCase() === "authorization",
  );

  if (
    typeof secrets.access_token === "string" &&
    secrets.access_token.length > 0 &&
    !hasAuthorizationHeader
  ) {
    headers.Authorization = `Bearer ${secrets.access_token}`;
  } else if (
    typeof secrets.raw_access_token === "string" &&
    secrets.raw_access_token.length > 0 &&
    !hasAuthorizationHeader
  ) {
    headers.Authorization = String(secrets.raw_access_token);
  }

  return headers;
}

function fingerprintHeaders(headers: Record<string, string>): string {
  const canonicalHeaders = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  return createHash("sha256")
    .update(JSON.stringify(canonicalHeaders))
    .digest("base64url");
}
