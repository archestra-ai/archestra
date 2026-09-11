/**
 * Generic LLM Proxy Handler
 *
 * A reusable handler that works with any LLM provider through the adapter pattern.
 * Routes choose which adapter factory to use based on URL.
 */

import { randomUUID } from "node:crypto";
import {
  APP_ID_HEADER,
  ArchestraInternalErrorCode,
  type BillingMode,
  BUILT_IN_AGENT_IDS,
  CHAT_API_KEY_ID_HEADER,
  DELEGATION_BILLING_ENVIRONMENT_HEADER,
  DUAL_LLM_PROGRESS_CHANNEL_HEADER,
  hasArchestraTokenPrefix,
  type InteractionSource,
  InteractionSourceSchema,
  isProviderApiKeyOptional,
  PROVIDER_BASE_URL_HEADER,
  providerDisplayNames,
  providerRequiresPerUserCredential,
  SOURCE_HEADER,
  stripClaudeContextVariantSuffix,
  UNTRUSTED_CONTEXT_HEADER,
} from "@archestra/shared";
import {
  type Context,
  context as otelContext,
  propagation,
  trace,
} from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { isAnthropicKeylessAuthEnabled } from "@/clients/anthropic-keyless-auth";
import { anthropicVertexClient } from "@/clients/anthropic-vertex";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import config from "@/config";
import {
  LOCKED_CHAT_KEY_HEADER,
  parseLockedChatDekHeader,
} from "@/content-encryption/locked-chat";
import {
  type DualLlmProgressEvent,
  dualLlmProgressBus,
} from "@/guardrails/dual-llm-progress-bus";
import logger from "@/logging";
import {
  AgentTeamModel,
  AppaProxySessionModel,
  AppaProxySessionProtocolError,
  AppModel,
  EnvironmentModel,
  InteractionModel,
  LimitValidationService,
  LlmProviderApiKeyModel,
  ModelModel,
  OrganizationModel,
  TeamModel,
  UserModel,
} from "@/models";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import { metrics } from "@/observability";
import {
  ATTR_ARCHESTRA_BILLING_MODE,
  ATTR_ARCHESTRA_COST,
  ATTR_ARCHESTRA_USAGE_CACHE_CREATION_1H_INPUT_TOKENS,
  ATTR_GENAI_COMPLETION,
  ATTR_GENAI_RESPONSE_FINISH_REASONS,
  ATTR_GENAI_RESPONSE_ID,
  ATTR_GENAI_RESPONSE_MODEL,
  ATTR_GENAI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GENAI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GENAI_USAGE_INPUT_TOKENS,
  ATTR_GENAI_USAGE_OUTPUT_TOKENS,
  ATTR_GENAI_USAGE_REASONING_OUTPUT_TOKENS,
  ATTR_GENAI_USAGE_TOTAL_TOKENS,
  EVENT_GENAI_CONTENT_COMPLETION,
  type SpanTeamInfo,
} from "@/observability/tracing";
import { getAppaPluginArchestra } from "@/plugins/appa-plugin-archestra";
import {
  type AppaNativeClient,
  classifyAppaNativeClient,
  collectAppaProtocolToolResults,
  resolveAppaCarrierChild,
  unsupportedNativeLifecycleReason,
} from "@/services/appa-client-correlation";
import {
  type NativeCodexHistory,
  persistNativeCodexHistory,
  validateNativeCodexHistory,
} from "@/services/appa-codex-history";
import {
  commitNativeCodexCalls,
  createNativeCodexBootstrap,
  isNativeCodexCodeModeRequest,
  isNativeCodexCompactionV2,
  issuedCodexToolSearchMcpTargets,
  issueNativeCodexFrame,
  loadIssuedCodexToolSearchRegistry,
  nativeCodexBootstrapSse,
  nativeCodexPolicyToolName,
  normalizeNativeCodexInput,
  prepareNativeCodexCallAliases,
  projectNativeCodexModelRequest,
  recordNativeCodexDiscovery,
  replaceNativeCodexCallItems,
  resolveNativeCodexGatewayPrincipals,
  restoreNativeCodexProviderIds,
  rewriteNativeCodexResponseForClient,
  stripNativeCodexControlHistory,
  toNativeCodexToolNames,
} from "@/services/appa-codex-native-bridge";
import {
  normalizeNativeCodexProcessHistory,
  restoreNativeCodexClientProcessCalls,
} from "@/services/appa-codex-process-routing";
import {
  AppaHeldResponseController,
  type AppaSyntheticControlCall,
} from "@/services/appa-held-response-controller";
import {
  AppaHistoryCodec,
  type AppaHistoryProtocol,
} from "@/services/appa-history-codec";
import {
  attachNativeChild,
  extractNativeChildRequest,
  extractNativeTaskPath,
  prepareNativeChildSpawnPublication,
  resolveNativeChildSpawnBinding,
} from "@/services/appa-native-child-correlation";
import { AppaProxyLedger } from "@/services/appa-proxy/ledger";
import { enrichDiscoveredModel } from "@/services/discovered-model-enrichment";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import {
  ApiError,
  DUAL_LLM_KEEPALIVE_SSE_COMMENT,
  type DualLlmAnalysis,
  type GatewayAgent,
  type InsertInteraction,
  type InteractionAuthMethod,
  type InteractionRequest,
  type InteractionResponse,
  type LLMProvider,
  type LLMStreamAdapter,
  type ToolCallBlock,
  type ToolCompressionStats,
  type ToonSkipReason,
  UNSAFE_CONTEXT_BOUNDARY_REASON,
  type UnsafeContextBoundary,
} from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";
import { repairLoneSurrogates } from "@/utils/lone-surrogates";
import { isLoopbackRequest } from "@/utils/network";
import { isUuid } from "@/utils/uuid";
import { codexToolName } from "./adapters/openai-responses";
import { isCodexToolSearchCall } from "./appa-codex-wire";
import {
  type AppaInboundToolResult,
  type AppaOutboundToolCall,
  AppaProxyHookError,
  AppaProxyHookSession,
  canonicalJsonObject,
  deriveAppaOwnerScope,
} from "./appa-proxy-hook";

import {
  assertAuthenticatedForKeylessProvider,
  assertConsistentUserCredentials,
  attemptJwksAuth,
  resolveAgent,
  validateLlmOAuthAccessToken,
  validatePassthroughVirtualKey,
  validateVirtualApiKey,
  virtualKeyRateLimiter,
} from "./llm-proxy-auth";
import {
  type AccumulatedToolCall,
  applyInputTokenFallback,
  buildInteractionRecord,
  calculateInteractionCosts,
  canonicalizeCommonMessageToolNames,
  handleError,
  normalizeToolCallsForPolicy,
  planDispatchModeToolCallRewrites,
  recordBlockedToolCallMetrics,
  shouldForwardAnthropicBeta,
  toSpanUserInfo,
  toToolCallBlock,
  withSessionContext,
} from "./llm-proxy-helpers";
import { StreamKeepAlive } from "./stream-keepalive";
import * as utils from "./utils";
import type { SessionSource } from "./utils/headers/session-id";
import {
  type LockedChatAuditDisposition,
  redactLockedChatInteraction,
  resolveLockedChatAuditContext,
} from "./utils/locked-chat-session";

const APPA_SPAWN_BINDINGS_HEADER = "x-archestra-appa-spawn-bindings";

const {
  observability: {
    otel: { captureContent, contentMaxLength },
  },
} = config;

/**
 * Shared context passed to streaming and non-streaming handlers.
 * Groups the 15+ parameters that both handlers need into a single object
 * for maintainability and readability.
 */
export interface LLMProxyContext<TRequest> {
  agent: GatewayAgent;
  originalRequest: TRequest;
  actualModel: string;
  contextIsTrusted: boolean;
  enabledToolNames: Set<string>;
  nativeCodexApplyPatch: boolean;
  nativeCodex: boolean;
  nativeCodexHistory?: NativeCodexHistory;
  /** Proven by a credential, never by a user-attribution header. */
  authenticatedUserId?: string;
  /** Server-resolved principals for registered native MCP gateway namespaces. */
  nativeCodexGatewayPrincipals: ReadonlyMap<
    string,
    { principalUserId: string; gatewayProfileId: string }
  >;
  nativeCodexControl?: {
    userId: string;
    namespace: string;
    threadId: string;
  };
  appaNativeClient: AppaNativeClient;
  /** Maps client-decorated gateway tool names to the platform's own names. */
  canonicalizeToolName: utils.gatewayToolNames.ToolNameCanonicalizer;
  /** APPA-only canonical identities proven by this request's MCP declarations. */
  declaredMcpToolTargets: ReadonlyMap<string, string>;
  toonStats: ToolCompressionStats;
  toonSkipReason: ToonSkipReason | null;
  dualLlmAnalyses: DualLlmAnalysis[];
  unsafeContextBoundary?: UnsafeContextBoundary;
  /**
   * Locked chat session: span content capture is suppressed and persisted
   * content is either encrypted or redacted (usage/cost metadata untouched).
   * True whenever `locked-chat.kind !== "none"`.
   */
  suppressContent: boolean;
  /**
   * How this request's persisted audit content must be keyed. `encrypt`
   * carries the validated conversation key; `redact` is the fail-closed
   * fallback. Resolved once per request so every write site agrees.
   */
  lockedChat: LockedChatAuditDisposition;
  /**
   * Caller environment an advisor consultation bills to, resolved from the
   * loopback-gated delegation header and re-validated against the executing
   * agent row. Undefined for every non-advisor request.
   */
  delegationBillingEnvironmentId?: string;
  /**
   * MCP App whose runtime made this call, resolved from the loopback-gated app
   * header and re-validated against the executing agent's organization.
   * Undefined for every request that is not an app-runtime completion.
   */
  appId?: string;
  externalAgentId?: string;
  authMethod?: InteractionAuthMethod;
  /** Whether this call incurs a per-token charge (`metered`) or is subscription-covered. */
  billingMode: BillingMode;
  /** Billing can be refined from provider response headers after execution. */
  getBillingMode: () => BillingMode;
  authenticatedApp?: {
    id: string;
    name: string;
    clientId: string;
  };
  userId?: string;
  resolvedUser?: { id: string; email: string; name: string } | null;
  virtualKeyId?: string;
  passthroughVirtualKeyId?: string;
  sessionId?: string | null;
  sessionSource?: SessionSource;
  source: InteractionSource;
  runId?: string;
  parentContext?: Context;
  teamIds?: string[];
  teams?: SpanTeamInfo[];
  userTeams?: SpanTeamInfo[];
  appaHook?: AppaProxyHookSession;
  nativeClientTaskPath: string | null;
  nativeLogicalTaskPath: string | null;
  /**
   * Client-visible latency clock. `requestReceivedAt` is stamped on entry to
   * the handler; `firstByteAt` is set by `ensureStreamHeaders` the moment the
   * response is committed — which, on a lazily committed stream, is also the
   * first byte the client sees, wherever in preflight or streaming it happens.
   */
  streamTiming: StreamTiming;
}

export interface StreamTiming {
  requestReceivedAt: number;
  firstByteAt?: number;
}

export type LLMProxyAuthOverride = {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  /** Mapped chat_api_key row ID; used by the proxy to look up per-key settings (e.g. extra headers). */
  chatApiKeyId?: string;
  authenticated: boolean;
  source?: InteractionSource;
  authMethod?: InteractionAuthMethod;
  /** Model Router virtual key ID, preserved for usage limits and interaction attribution. */
  virtualKeyId?: string;
  authenticatedApp?: {
    id: string;
    name: string;
    clientId: string;
  };
  userId?: string;
};

export type LLMProxyRequestOptions = {
  /** The route is the legacy Codex `POST /responses/compact` transport. */
  nativeCodexLegacyCompact?: boolean;
};

function getProviderMessagesCount(messages: unknown): number | null {
  if (Array.isArray(messages)) {
    return messages.length;
  }

  if (messages && typeof messages === "object") {
    const candidate = messages as Record<string, unknown>;
    if (Array.isArray(candidate.messages)) {
      return candidate.messages.length;
    }
  }

  return null;
}

function proxyTraceId(parentContext: Context): string | undefined {
  return (
    trace.getSpan(parentContext)?.spanContext().traceId ??
    trace.getSpan(otelContext.active())?.spanContext().traceId
  );
}

/**
 * The subset of a proxied request body we read for session-id and client-app
 * extraction. Each consumer only touches its own fields (`detectClaudeClientId`
 * → `system`/`metadata`; `detectCodexClientId` → `client_metadata`;
 * `extractSessionInfo` → `metadata`/`user`/`client_metadata`), so one shared
 * view keeps the cast in a single place.
 */
type RequestBodyForExtraction =
  | {
      system?: unknown;
      metadata?: { user_id?: string | null };
      user?: string | null;
      client_metadata?: unknown;
    }
  | undefined;

/**
 * Generic LLM proxy handler that works with any provider through adapters
 */
export async function handleLLMProxy<
  TRequest,
  TResponse,
  TMessages,
  TChunk,
  THeaders,
>(
  body: TRequest,
  request: FastifyRequest,
  reply: FastifyReply,
  provider: LLMProvider<TRequest, TResponse, TMessages, TChunk, THeaders>,
  options: LLMProxyRequestOptions = {},
): Promise<FastifyReply> {
  const streamTiming: StreamTiming = { requestReceivedAt: Date.now() };
  const headers = request.headers as unknown as THeaders;
  const agentId = (request.params as { agentId?: string }).agentId;
  const providerName = provider.provider;

  // Extract header-based context
  const headersForExtraction = headers as Record<
    string,
    string | string[] | undefined
  >;
  const bodyForExtraction = body as RequestBodyForExtraction;
  // Client-app attribution: the caller-supplied X-Archestra-Agent-Id header (or
  // X-Archestra-Meta segment 0) wins; otherwise auto-discover a known client
  // app from the request and record it (Claude clients → "anthropic_claude"
  // from the request body; Codex clients → "openai_codex" from the
  // client_metadata body shape or the originator/User-Agent headers the Codex
  // CLI stamps on every request; Cursor → "cursor" from its User-Agent).
  const externalAgentId =
    utils.headers.externalAgentId.getExternalAgentId(headersForExtraction) ??
    utils.headers.clientApp.detectClaudeClientId(bodyForExtraction) ??
    utils.headers.clientApp.detectCodexClientId(
      headersForExtraction,
      bodyForExtraction,
    ) ??
    utils.headers.clientApp.detectCursorClientId(headersForExtraction);
  const runId = utils.headers.runId.getRunId(headersForExtraction);
  const authOverride = (
    request as FastifyRequest & { llmProxyAuthOverride?: LLMProxyAuthOverride }
  ).llmProxyAuthOverride;
  const passthroughVirtualKeyToken =
    utils.headers.virtualKey.getPassthroughVirtualKeyToken(
      headersForExtraction,
    );
  // The X-Archestra-User-Id header is an unauthenticated hint; it does not
  // participate in the cross-credential user-consistency check below.
  let userId = (await utils.headers.userId.getUser(headersForExtraction))
    ?.userId;
  let resolvedUser = userId ? await UserModel.getById(userId) : null;
  let virtualKeyId = authOverride?.virtualKeyId;
  let passthroughVirtualKeyId: string | undefined;
  // Authenticated user identities, tracked per source for the consistency check.
  let passthroughUserId: string | undefined;
  let jwksUserId: string | undefined;
  let oauthUserId: string | undefined;
  let regularVirtualKeyUserId: string | undefined;

  // Session extraction reuses the resolved client attribution above to gate
  // the Codex-specific signals, so client identification lives in one place.
  const { sessionId, sessionSource } =
    utils.headers.sessionId.extractSessionInfo({
      headers: headersForExtraction,
      body: bodyForExtraction,
      externalAgentId,
    });

  // Extract interaction source (chat, chatops, email, etc.)
  // Internal callers set X-Archestra-Source; external API requests default to "api".
  const rawSource = utils.headers.metaHeader.getHeaderValue(
    headersForExtraction,
    SOURCE_HEADER,
  );
  const parsedSource = InteractionSourceSchema.safeParse(rawSource).data;
  // `model_router` is assigned by the route auth override, not accepted from
  // the public source header.
  const source: InteractionSource =
    authOverride?.source ??
    (parsedSource === "model_router" ? "api" : parsedSource) ??
    "api";
  const inheritedContextUntrusted =
    utils.headers.metaHeader.getHeaderValue(
      headersForExtraction,
      UNTRUSTED_CONTEXT_HEADER,
    ) === "true";

  // Extract W3C trace context (traceparent/tracestate) from incoming request headers.
  // When the chat route calls the LLM proxy via localhost, the traced fetch injects these
  // headers so the LLM span becomes a child of the chat parent span.
  // For external API calls (no traceparent header), this returns root context (unchanged behavior).
  const parentContext = propagation.extract(
    otelContext.active(),
    request.headers,
  );
  getAppaPluginArchestra();

  let requestBody = config.llmProxy.appaHook?.nativeCodexEnabled
    ? normalizeNativeCodexInput(body)
    : body;
  let nativeCodexToolNames: string[] = [];
  let nativeCodexIssuedMcpTargets: ReadonlyMap<string, string> = new Map();
  let nativeCodexGatewayPrincipals: ReadonlyMap<
    string,
    { principalUserId: string; gatewayProfileId: string }
  > = new Map();
  let nativeCodexHistory: NativeCodexHistory | undefined;
  let nativeCodexControl: LLMProxyContext<TRequest>["nativeCodexControl"];
  let nativeClientTaskPath: string | null = null;
  let nativeLogicalTaskPath: string | null = null;
  let appaNativeClient: AppaNativeClient = "unknown";
  const nativeCodexRequested =
    config.llmProxy.appaHook?.nativeCodexEnabled === true &&
    provider.interactionType === "openai:responses" &&
    (options.nativeCodexLegacyCompact ||
      isNativeCodexCodeModeRequest(requestBody) ||
      isNativeCodexCompactionV2(requestBody));
  let requestAdapter = provider.createRequestAdapter(requestBody as TRequest);
  let streamAdapter = provider.createStreamAdapter(requestBody as TRequest);
  const providerMessages = requestAdapter.getProviderMessages();
  const messagesCount = getProviderMessagesCount(providerMessages);

  logger.debug(
    {
      agentId,
      model: requestAdapter.getModel(),
      stream: requestAdapter.isStreaming(),
      messagesCount,
      toolsCount: requestAdapter.getTools().length,
    },
    `[${providerName}Proxy] handleLLMProxy: request received`,
  );

  // Resolve agent
  const resolvedAgent = await resolveAgent(agentId);
  const resolvedAgentId = resolvedAgent.id;
  logger.debug(
    { resolvedAgentId, agentName: resolvedAgent.name, wasExplicit: !!agentId },
    `[${providerName}Proxy] Agent resolved`,
  );

  if (runId) {
    const existsInDb = await InteractionModel.existsByRunId(runId);
    if (!existsInDb) {
      logger.debug(
        { runId, agentId: resolvedAgentId, externalAgentId },
        `[${providerName}Proxy] New execution detected, reporting metric`,
      );
      metrics.agentRun.reportAgentRun({
        runId,
        profile: resolvedAgent,
        externalAgentId,
      });
    } else {
      logger.debug(
        { runId, agentId: resolvedAgentId },
        `[${providerName}Proxy] Execution already exists in DB, skipping metric`,
      );
    }
  }

  // Resolve a passthrough virtual key (X-Archestra-Virtual-Key). It authenticates
  // the acting Archestra user and gates proxy access, but carries no provider
  // credential — the provider auth still comes from the Authorization header.
  // Skipped for internal loopback auth overrides (in-app chat).
  if (passthroughVirtualKeyToken && !authOverride) {
    await virtualKeyRateLimiter.check({
      ip: request.ip,
      credential: passthroughVirtualKeyToken,
    });
    try {
      const passthroughResult = await validatePassthroughVirtualKey({
        tokenValue: passthroughVirtualKeyToken,
        agent: resolvedAgent,
      });
      await virtualKeyRateLimiter.recordSuccess({
        credential: passthroughVirtualKeyToken,
      });
      passthroughVirtualKeyId = passthroughResult.passthroughVirtualKeyId;
      passthroughUserId = passthroughResult.userId;
      // Authenticated identity → overrides the unauthenticated X-Archestra-User-Id.
      userId = passthroughResult.userId;
      resolvedUser = await UserModel.getById(userId);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 401) {
        await virtualKeyRateLimiter.recordFailure({
          ip: request.ip,
          credential: passthroughVirtualKeyToken,
        });
      }
      throw error;
    }
  }

  // Authenticate and resolve API key (JWKS → virtual key → header extraction → keyless check)
  let apiKey: string | undefined;
  let perKeyBaseUrl: string | undefined;
  let perKeyProviderApiKeyRow: Awaited<
    ReturnType<typeof LlmProviderApiKeyModel.findById>
  > = null;
  /**
   * The chat_api_key row ID for this call, if the call resolved through a
   * DB-managed key OR was forwarded by an internal loopback caller via
   * CHAT_API_KEY_ID_HEADER. Used at the bottom of the handler to look up
   * extra HTTP headers. `undefined` for raw-bearer calls from external IPs.
   */
  let perKeyChatApiKeyId: string | undefined;
  let perKeyChatApiKeyIdFromLoopbackHeader = false;
  let wasJwksAuthenticated = false;
  let wasVirtualKeyResolved = false;
  let wasOAuthAuthenticated = false;
  let authMethod = authOverride?.authMethod;
  let authenticatedApp = authOverride?.authenticatedApp;
  if (authOverride?.userId) {
    userId = authOverride.userId;
    resolvedUser = await UserModel.getById(userId);
  }
  // 1. Try JWKS auth if the agent has an external identity provider configured
  if (authOverride) {
    apiKey = authOverride.apiKey;
    perKeyBaseUrl = authOverride.baseUrl;
    perKeyChatApiKeyId = authOverride.chatApiKeyId;
    wasVirtualKeyResolved = authOverride.authenticated;
  } else {
    const jwksResult = await attemptJwksAuth(
      request,
      resolvedAgent,
      providerName,
    );
    if (jwksResult) {
      wasJwksAuthenticated = true;
      authMethod = "jwks";
      apiKey = jwksResult.apiKey;
      perKeyBaseUrl = jwksResult.baseUrl;
      perKeyChatApiKeyId = jwksResult.chatApiKeyId;
      if (jwksResult.userId) {
        jwksUserId = jwksResult.userId;
        userId = jwksResult.userId;
        resolvedUser = await UserModel.getById(userId);
      }
    }
  }

  // 2. Extract API key from headers if not already resolved via JWKS
  if (!authOverride && !wasJwksAuthenticated) {
    apiKey = provider.extractApiKey(headers);
  }

  // 3. Resolve platform-managed virtual API keys.
  // Some adapters return a standard "Bearer <token>" value while Anthropic uses
  // a "Bearer:<token>" sentinel so downstream client creation can distinguish
  // auth tokens from raw API keys. Normalize both forms before virtual-key lookup.
  const rawApiKey = normalizeVirtualKeyCandidate(apiKey);

  // In-app chat forwards a stored provider secret through the local proxy
  // (loopback) tagged with CHAT_API_KEY_ID_HEADER and a downstream
  // PROVIDER_BASE_URL_HEADER. That secret can itself be an `arch_*` virtual key
  // whose mapped provider is ANOTHER Archestra instance — not one of this
  // instance's keys — so it must be forwarded to that downstream base URL
  // rather than rejected by local virtual-key lookup. Requiring the base-URL
  // header keeps the clean local 401 when there is no downstream to forward to
  // (an `arch_*` secret would otherwise leak to the default public provider).
  const chatApiKeyIdHeader =
    headersForExtraction[CHAT_API_KEY_ID_HEADER.toLowerCase()];
  const providerBaseUrlHeaderValue =
    headersForExtraction[PROVIDER_BASE_URL_HEADER.toLowerCase()];
  const isInternalChatForward =
    isLoopbackRequest(request) &&
    typeof chatApiKeyIdHeader === "string" &&
    chatApiKeyIdHeader.length > 0 &&
    typeof providerBaseUrlHeaderValue === "string" &&
    providerBaseUrlHeaderValue.length > 0;

  if (
    !wasJwksAuthenticated &&
    !authOverride &&
    rawApiKey &&
    !hasArchestraTokenPrefix(rawApiKey)
  ) {
    const oauthResult = await validateLlmOAuthAccessToken({
      tokenValue: rawApiKey,
      expectedProvider: providerName,
      agent: resolvedAgent,
      requestedModel: requestAdapter.getModel(),
    });
    if (oauthResult) {
      apiKey = oauthResult.apiKey;
      perKeyBaseUrl = oauthResult.baseUrl;
      perKeyChatApiKeyId = oauthResult.chatApiKeyId;
      wasOAuthAuthenticated = true;
      authMethod = oauthResult.authMethod;
      authenticatedApp = oauthResult.authenticatedApp;
      if (oauthResult.userId) {
        oauthUserId = oauthResult.userId;
        userId = oauthResult.userId;
        resolvedUser = await UserModel.getById(userId);
      }
    }
  }
  if (
    !wasJwksAuthenticated &&
    !authOverride &&
    rawApiKey &&
    hasArchestraTokenPrefix(rawApiKey)
  ) {
    await virtualKeyRateLimiter.check({
      ip: request.ip,
      credential: rawApiKey,
    });
    try {
      const virtualResult = await validateVirtualApiKey({
        tokenValue: rawApiKey,
        expectedProvider: providerName,
        expectedOrganizationId: resolvedAgent.organizationId,
      });
      await virtualKeyRateLimiter.recordSuccess({ credential: rawApiKey });
      apiKey = virtualResult.apiKey;
      perKeyBaseUrl = virtualResult.baseUrl;
      perKeyChatApiKeyId = virtualResult.chatApiKeyId;
      wasVirtualKeyResolved = true;
      virtualKeyId = virtualResult.virtualKeyId;
      // A personal standard virtual key identifies its owner; include it in the
      // cross-credential consistency check.
      if (virtualResult.virtualKeyScope === "personal") {
        regularVirtualKeyUserId = virtualResult.virtualKeyAuthorId ?? undefined;
      }
      authMethod = "virtual_key";
    } catch (error) {
      // The token resolved as a local virtual key on success above. If it
      // didn't and this is an internal chat forward, the secret belongs to a
      // downstream Archestra instance: leave `apiKey` as the raw secret so it
      // is forwarded to the provider base URL (which validates it), rather than
      // failing or penalizing the loopback caller's rate limit.
      if (
        isInternalChatForward &&
        error instanceof ApiError &&
        error.statusCode === 401
      ) {
        logger.info(
          { chatApiKeyId: chatApiKeyIdHeader },
          `[${providerName}Proxy] forwarding non-local virtual key to provider base URL`,
        );
      } else {
        if (error instanceof ApiError && error.statusCode === 401) {
          await virtualKeyRateLimiter.recordFailure({
            ip: request.ip,
            credential: rawApiKey,
          });
        }
        throw error;
      }
    }
  }

  // 4. Internal callers (in-app chat) that send a raw provider secret can
  // forward the resolved chat_api_keys row ID via a loopback-only header so
  // the proxy can pick up per-key configuration (extraHeaders) below.
  // External clients must NOT be able to spoof this — same SSRF reasoning
  // as PROVIDER_BASE_URL_HEADER.
  if (!perKeyChatApiKeyId) {
    const headerValue =
      headersForExtraction[CHAT_API_KEY_ID_HEADER.toLowerCase()];
    const headerPresent =
      typeof headerValue === "string" && headerValue.length > 0;
    if (isLoopbackRequest(request)) {
      if (headerPresent) {
        perKeyChatApiKeyId = headerValue;
        perKeyChatApiKeyIdFromLoopbackHeader = true;
        logger.info(
          { chatApiKeyId: perKeyChatApiKeyId },
          `[${providerName}Proxy] received provider-api-key-id header`,
        );
      }
    } else if (headerPresent) {
      logger.warn(
        { ip: request.socket.remoteAddress },
        `[${providerName}Proxy] ignoring provider-api-key-id header from non-loopback request`,
      );
    }
  }

  if (perKeyChatApiKeyId && perKeyChatApiKeyIdFromLoopbackHeader) {
    perKeyProviderApiKeyRow =
      await LlmProviderApiKeyModel.findById(perKeyChatApiKeyId);

    if (
      shouldUseKeylessProviderApiKey({
        row: perKeyProviderApiKeyRow,
        providerName,
      })
    ) {
      apiKey = undefined;
      perKeyBaseUrl =
        perKeyProviderApiKeyRow?.inferenceBaseUrl ??
        perKeyProviderApiKeyRow?.baseUrl ??
        perKeyBaseUrl;
      logger.info(
        { chatApiKeyId: perKeyChatApiKeyId },
        `[${providerName}Proxy] using keyless stored provider key configuration`,
      );
    }
  }

  // Per-user providers (e.g. GitHub Copilot) require the acting user's own
  // linked credential. When none resolved, fail fast with an actionable error
  // pointing at the connect flow — rather than forwarding a keyless request
  // that the upstream would reject with a generic 401. `internal_code` gives
  // first-party clients a machine-readable signal (mirrors
  // ChatErrorCode.ProviderAuthRequired); the connect URL is in the message so
  // generic OpenAI/Anthropic clients surface something actionable too.
  if (providerRequiresPerUserCredential(providerName) && !apiKey) {
    const providerLabel = providerDisplayNames[providerName];
    const connectUrl = `${config.frontendBaseUrl}/settings`;
    logger.info(
      { providerName },
      `[${providerName}Proxy] no per-user credential for acting user; returning provider_auth_required`,
    );
    return reply.status(401).send({
      error: {
        message: `${providerLabel} isn't connected for your account. Connect it at ${connectUrl} then retry your request.`,
        type: "api_authentication_error",
        internal_code: ArchestraInternalErrorCode.ProviderAuthRequired,
      },
    });
  }

  // 5. Enforce authentication for keyless providers on external requests.
  // A passthrough key authenticates the user but carries no provider credential,
  // so it intentionally does not satisfy the keyless-provider requirement.
  assertAuthenticatedForKeylessProvider({
    apiKey,
    wasVirtualKeyResolved: wasVirtualKeyResolved || wasOAuthAuthenticated,
    wasJwksAuthenticated,
    isLoopbackCaller: isLoopbackRequest(request),
    providerSuppliesServerCredential:
      providerSuppliesServerCredential(providerName),
  });

  // All authenticated user-scoped credentials must resolve to the same user.
  assertConsistentUserCredentials([
    passthroughUserId,
    jwksUserId,
    oauthUserId,
    regularVirtualKeyUserId,
  ]);

  // The acting user as proven by a credential, as opposed to `userId`, which
  // starts from the unauthenticated X-Archestra-User-Id / OpenWebUI-email
  // headers. Those headers are attribution hints — good enough for logging and
  // usage records, never sufficient to unlock access — so authorization checks
  // must read this instead. Undefined for org-scoped virtual keys, OAuth client
  // credentials, and raw provider-key calls, none of which identify a user.
  const authenticatedUserId =
    authOverride?.userId ??
    passthroughUserId ??
    jwksUserId ??
    oauthUserId ??
    regularVirtualKeyUserId;

  // Fall back to the personal standard virtual key's owner for user attribution.
  // Higher-precedence sources — the passthrough key, JWKS, OAuth, and the
  // X-Archestra-User-Id header — already set `userId` above, so this only fills
  // the gap when a personal virtual key is the sole identity signal. That is the
  // virtual-key connection mode: the connect flow mints a personal virtual key
  // whose author is the acting user (Codex ChatGPT subscription, Claude Code
  // virtual key). Consistency with any other authenticated identity was just
  // asserted, so this can never disagree with them.
  if (!userId && regularVirtualKeyUserId) {
    userId = regularVirtualKeyUserId;
    resolvedUser = await UserModel.getById(userId);
  }

  if (!authMethod) {
    authMethod = passthroughVirtualKeyId
      ? "passthrough_virtual_key"
      : isLoopbackRequest(request)
        ? "internal"
        : "provider_key";
  }

  // Locked chat sessions: interaction rows keep all usage/cost/session
  // metadata, but their content-bearing fields are encrypted under the
  // conversation's browser-held key (or redacted if that cannot be done
  // safely), and span content capture is suppressed either way. Resolved once
  // up front (server-derived, fail closed) so the catch below and both stream
  // handlers agree on it.
  const lockedChat = await resolveLockedChatAuditContext({
    source,
    // The raw socket peer, NOT request.ip: trustProxy can rewrite request.ip
    // from forwarded headers, and this seam must only ever match the
    // loopback socket the in-app chat actually dials.
    requestIp: request.socket.remoteAddress,
    sessionId,
    userId,
    dek: readLockedChatDek(request),
  });
  // Content never reaches spans or logs for a locked-chat session, whether it
  // ends up encrypted or redacted.
  const suppressContent = lockedChat.kind !== "none";

  // Advisor consultations bill to the delegating caller's environment (the
  // advisor's own row is env-less). Resolved once so the limit check and every
  // interaction write agree on it.
  const delegationBillingEnvironmentId =
    await resolveDelegationBillingEnvironment(request, resolvedAgent);

  // App-runtime completions carry the calling app, so per-app runtime spend is
  // attributable instead of collapsing into the shared App Runtime agent.
  const attributedAppId = await resolveAttributedAppId(request, resolvedAgent);

  let activeAppaHook: AppaProxyHookSession | undefined;

  // Check usage limits
  try {
    appaNativeClient = config.llmProxy.appaHook
      ? classifyAppaNativeClient({
          provider: providerName,
          interactionType: provider.interactionType,
          headers: headersForExtraction,
          request: requestAdapter.getOriginalRequest(),
        })
      : "unknown";
    const appaThreadCandidate = config.llmProxy.appaHook
      ? resolveAppaThreadContext({
          headers: headersForExtraction,
          request: requestAdapter.getOriginalRequest(),
          sessionId,
          sessionSource,
          nativeClient: appaNativeClient,
        })
      : null;
    // Once configured, APPA owns every request on this proxy boundary. A
    // request without a stable trajectory cannot safely bypass the gate.
    if (config.llmProxy.appaHook) {
      if (
        hasProviderHostedMcpToolDefinition(requestAdapter.getOriginalRequest())
      ) {
        throw new ApiError(
          400,
          "OpenAPPA proxy hooks do not permit provider-hosted MCP tools.",
        );
      }
      if (
        !nativeCodexRequested &&
        !isAppaHookSupportedRequest(
          provider,
          requestAdapter.getOriginalRequest(),
        )
      ) {
        throw new ApiError(
          400,
          "OpenAPPA proxy hooks support only OpenAI Chat Completions or Responses requests with ordinary JSON function tools.",
        );
      }
      if (
        hasUnsupportedOpaqueProxyContext(requestAdapter.getOriginalRequest())
      ) {
        throw new ApiError(
          400,
          "OpenAPPA proxy hooks do not support hidden Responses continuation context.",
        );
      }
      let appaThread = appaThreadCandidate;
      if (!appaThread || "error" in appaThread) {
        throw new ApiError(
          400,
          appaThread && "error" in appaThread
            ? appaThread.error
            : "OpenAPPA proxy hooks require a stable thread id.",
        );
      }
      if (
        !isValidAppaSessionId(appaThread.threadId) ||
        (appaThread.parentThreadId !== undefined &&
          !isValidAppaSessionId(appaThread.parentThreadId))
      ) {
        throw new ApiError(
          400,
          "OpenAPPA proxy hooks require a stable thread id.",
        );
      }
      const nativeChildRequest = nativeCodexRequested
        ? extractNativeChildRequest({
            headers: headersForExtraction,
            request: requestAdapter.getOriginalRequest(),
          })
        : null;
      if (
        nativeCodexRequested &&
        appaThread.parentThreadId !== undefined &&
        !nativeChildRequest
      ) {
        throw new ApiError(
          400,
          "Native Codex child requests require verified task metadata.",
        );
      }
      nativeClientTaskPath = nativeCodexRequested
        ? extractNativeTaskPath({
            headers: headersForExtraction,
            request: requestAdapter.getOriginalRequest(),
          })
        : null;
      nativeLogicalTaskPath =
        nativeClientTaskPath === "/root" ? "/tasks/root" : null;
      const ownerScopeHash = deriveAppaOwnerScope({
        secret: config.llmProxy.appaHook.sessionHmacSecret,
        profileId: resolvedAgent.id,
        virtualKeyId,
        passthroughVirtualKeyId,
        authenticatedPrincipalId: authenticatedUserId,
        authenticatedAppId: authenticatedApp?.id,
        rawProviderCredential: rawApiKey ?? apiKey,
      });
      if (!ownerScopeHash) {
        throw new ApiError(
          400,
          "OpenAPPA proxy hooks require an authenticated credential and principal binding.",
        );
      }
      try {
        if (nativeChildRequest) {
          if (
            appaThread.threadId !== nativeChildRequest.childClientSessionId ||
            (appaThread.parentThreadId !== undefined &&
              appaThread.parentThreadId !==
                nativeChildRequest.parentClientSessionId)
          ) {
            throw new ApiError(
              400,
              "Native Codex child thread metadata does not match the request thread.",
            );
          }
          const resolvedSpawn = await resolveNativeChildSpawnBinding({
            ownerScopeHash,
            profileId: resolvedAgent.id,
            parentClientSessionId: nativeChildRequest.parentClientSessionId,
            childTaskPath: nativeChildRequest.childTaskPath,
          });
          appaThread = {
            threadId: nativeChildRequest.childClientSessionId,
            parentThreadId: nativeChildRequest.parentClientSessionId,
            spawnBinding: resolvedSpawn.spawnBinding,
          };
          nativeClientTaskPath = nativeChildRequest.childTaskPath;
          nativeLogicalTaskPath = resolvedSpawn.logicalTaskPath;
        }
        const disconnect = new AbortController();
        reply.raw.once("finish", () => {
          activeAppaHook?.markOutboundCallsDelivered();
        });
        reply.raw.once("close", () => {
          if (reply.raw.writableFinished) return;
          disconnect.abort();
          if (activeAppaHook) {
            trackBackgroundWork(
              activeAppaHook.quarantineUndeliveredCalls().catch((error) => {
                logger.error(
                  { error },
                  "Failed to quarantine APPA calls before response delivery",
                );
              }),
            );
          }
        });
        if (reply.raw.destroyed) disconnect.abort();
        logger.debug(
          { nativeClient: appaNativeClient },
          "Resolved native APPA protocol evidence without using it for authorization",
        );
        const carrierChild = nativeCodexRequested
          ? null
          : await resolveAppaCarrierChild({
              client: appaNativeClient,
              headers: headersForExtraction,
              request: requestAdapter.getOriginalRequest(),
              sessionId: appaThread.threadId,
              ownerScopeHash,
              profileId: resolvedAgent.id,
            });
        if (carrierChild) {
          const expectedThread =
            appaNativeClient === "claude-code"
              ? carrierChild.parentClientSessionId
              : carrierChild.childClientSessionId;
          if (appaThread.threadId !== expectedThread) {
            throw new ApiError(
              400,
              "Native child session metadata does not match the proxy-issued carrier.",
            );
          }
          appaThread = {
            threadId: carrierChild.childClientSessionId,
            parentThreadId: carrierChild.parentClientSessionId,
            spawnBinding: carrierChild.spawnBinding,
          };
        }
        const unsupportedNativeLifecycle = unsupportedNativeLifecycleReason({
          client: appaNativeClient,
          headers: headersForExtraction,
          request: requestAdapter.getOriginalRequest(),
        });
        if (
          unsupportedNativeLifecycle &&
          !nativeCodexRequested &&
          !carrierChild
        ) {
          throw new ApiError(400, unsupportedNativeLifecycle);
        }
        let inboundToolResults = collectAppaInboundToolResults({
          request: nativeCodexRequested
            ? normalizeNativeCodexInput(body)
            : body,
          interactionType: provider.interactionType,
        });
        // Stock clients need not repeat deferred gateway declarations. Issued
        // controls are located through the authenticated durable wire ledger.
        if (nativeCodexRequested && authenticatedUserId) {
          const continuation =
            await new AppaHeldResponseController().continueBeforeAcquire({
              config: config.llmProxy.appaHook,
              organizationId: resolvedAgent.organizationId,
              authenticatedUserId,
              profileId: resolvedAgent.id,
              ownerScopeHash,
              threadId: appaThread.threadId,
              controlItemIds: nativeCodexFunctionCallItemIds(
                requestAdapter.getOriginalRequest(),
              ),
              results: inboundToolResults,
              signal: disconnect.signal,
            });
          if (continuation.state === "rejected") {
            throw new ApiError(
              400,
              "Invalid APPA native control continuation.",
            );
          }
          if (continuation.state === "pending") {
            throw new ApiError(409, "APPA native control is still pending.");
          }
          if (continuation.state === "historical") {
            const controlCallIds = new Set(continuation.controlCallIds);
            // Completed gateway controls are full-history artifacts, not new
            // APPA results or provider-visible model context.
            inboundToolResults = inboundToolResults.filter(
              (result) => !controlCallIds.has(result.id),
            );
            requestBody = stripNativeCodexControlHistory({
              request: requestBody,
              controlCallIds,
            });
            requestAdapter = provider.createRequestAdapter(
              requestBody as TRequest,
            );
            streamAdapter = provider.createStreamAdapter(
              requestBody as TRequest,
            );
          }
          if (
            continuation.state === "held" ||
            continuation.state === "committed"
          ) {
            activeAppaHook = continuation.session;
            const response = await restoreHeldNativeResponse({
              session: continuation.session,
              heldFrameId: continuation.heldFrameId,
              omitPublishedContext: true,
              calls:
                continuation.state === "held"
                  ? [continuation.control]
                  : continuation.calls,
            });
            if (continuation.state === "committed") {
              await continuation.session.finish();
            }
            continuation.session.markContinuationResponseReady();
            return requestAdapter.isStreaming()
              ? reply
                  .type("text/event-stream")
                  .send(nativeCodexBootstrapSse(response))
              : reply.send(response);
          }
        }
        const historyProtocol = appaHistoryProtocol(provider.interactionType);
        if (!historyProtocol) {
          throw new AppaProxySessionProtocolError(
            "APPA session has no supported history protocol",
          );
        }
        let forkCheckpointId: string | undefined;
        let forkRootId: string | undefined;
        // Compaction retains the existing client root. Only a newly observed
        // client session with an exact recorded provider prefix can attach a
        // checkpoint-forked root.
        if (
          config.llmProxy.appaHook.runtimeToken &&
          historyProtocol &&
          !nativeChildRequest &&
          !carrierChild &&
          !(await AppaProxySessionModel.hasOwnedSession({
            profileId: resolvedAgent.id,
            ownerScopeHash,
            clientSessionId: appaThread.threadId,
            binding: {
              provider: providerName,
              protocol: historyProtocol,
              model: stripClaudeContextVariantSuffix(requestAdapter.getModel()),
            },
          }))
        ) {
          const forkHistory = AppaHistoryCodec.request({
            protocol: historyProtocol,
            request: requestAdapter.getOriginalRequest(),
          });
          const matchingFork = await AppaProxyLedger.forForkLookup({
            ownerScopeHash,
            profileId: resolvedAgent.id,
          }).matchingCheckpointFork({
            provider: providerName,
            model: stripClaudeContextVariantSuffix(requestAdapter.getModel()),
            history: forkHistory,
          });
          if (matchingFork) {
            forkCheckpointId = matchingFork.checkpointId;
            forkRootId = `archestra-proxy:${randomUUID()}`;
          } else if (hasCheckpointForkIntent(forkHistory.history)) {
            throw new ApiError(
              400,
              "OpenAPPA checkpoint fork history does not match an issued response.",
            );
          }
        }
        activeAppaHook = await AppaProxyHookSession.acquire({
          config: config.llmProxy.appaHook,
          profileId: resolvedAgent.id,
          organizationId: resolvedAgent.organizationId,
          ownerScopeHash,
          provider: providerName,
          protocol: historyProtocol,
          model: stripClaudeContextVariantSuffix(requestAdapter.getModel()),
          clientSessionId: appaThread.threadId,
          parentClientSessionId: appaThread.parentThreadId,
          spawnBinding: appaThread.spawnBinding,
          forkCheckpointId,
          rootId: forkRootId,
          nativeCodexExecution: nativeCodexRequested,
          signal: disconnect.signal,
          traceId: proxyTraceId(parentContext),
          prepareInboundResults: nativeCodexRequested
            ? async (results, session) => {
                try {
                  await normalizeNativeCodexProcessHistory({
                    scope: session.getNativeWireScope(),
                    request: requestBody,
                  });
                } catch {
                  // The provider and opaque-history store can only see the
                  // durable proxy handle, never a client-local fallback.
                  throw new AppaProxyHookError("unavailable", "input");
                }
                nativeCodexHistory = await validateNativeCodexHistory({
                  session,
                  request: requestBody,
                  headers: request.headers,
                  provider: providerName,
                  principalUserId: authenticatedUserId,
                  legacyCompact: options.nativeCodexLegacyCompact,
                });
                return [...results];
              }
            : undefined,
          toolResults: inboundToolResults,
        });
        if (nativeChildRequest) {
          await attachNativeChild({
            ownerScopeHash,
            profileId: resolvedAgent.id,
            parentClientSessionId: nativeChildRequest.parentClientSessionId,
            childClientSessionId: nativeChildRequest.childClientSessionId,
            childTaskPath: nativeChildRequest.childTaskPath,
            spawnBinding: appaThread.spawnBinding ?? "",
          });
        }
        if (
          nativeCodexRequested &&
          !options.nativeCodexLegacyCompact &&
          !isNativeCodexCompactionV2(requestBody)
        ) {
          const nativeRequest = requestAdapter.getOriginalRequest();
          if (!isNativeCodexCodeModeRequest(nativeRequest)) {
            throw new ApiError(400, "Invalid native Codex request.");
          }
          const directRegistry = await recordNativeCodexDiscovery({
            session: activeAppaHook,
            request: nativeRequest,
          });
          if (!directRegistry) {
            const bootstrap = await createNativeCodexBootstrap({
              session: activeAppaHook,
              request: nativeRequest,
            });
            await activeAppaHook.releaseWithoutPrompt();
            activeAppaHook = undefined;
            return requestAdapter.isStreaming()
              ? reply
                  .type("text/event-stream")
                  .send(nativeCodexBootstrapSse(bootstrap))
              : reply.send(bootstrap);
          }
          const issuedToolSearchRegistry =
            await loadIssuedCodexToolSearchRegistry({
              session: activeAppaHook,
            });
          const registry = [...directRegistry, ...issuedToolSearchRegistry];
          nativeCodexToolNames = toNativeCodexToolNames(registry);
          nativeCodexIssuedMcpTargets =
            issuedCodexToolSearchMcpTargets(registry);
          nativeCodexGatewayPrincipals =
            await resolveNativeCodexGatewayPrincipals({
              organizationId: resolvedAgent.organizationId,
              registry,
            });
          const controlNamespace = authenticatedUserId
            ? registry.find(
                (tool) =>
                  typeof tool.namespace === "string" &&
                  /^mcp__[A-Za-z0-9_-]+$/.test(tool.namespace) &&
                  tool.name === "archestra__appa_execute_remedy",
              )?.namespace
            : undefined;
          nativeCodexControl =
            controlNamespace && authenticatedUserId
              ? {
                  userId: authenticatedUserId,
                  namespace: controlNamespace,
                  threadId: appaThread.threadId,
                }
              : undefined;
          const projected = await projectNativeCodexModelRequest({
            session: activeAppaHook,
            request: nativeRequest,
            registry,
            principalUserId: authenticatedUserId,
          });
          delete request.headers["x-openai-internal-codex-responses-lite"];
          requestAdapter = provider.createRequestAdapter(projected as TRequest);
          streamAdapter = provider.createStreamAdapter(projected as TRequest);
        }
        if (nativeCodexRequested && isNativeCodexCompactionV2(requestBody)) {
          const projected = await projectNativeCodexModelRequest({
            session: activeAppaHook,
            request: requestBody,
            registry: [],
            principalUserId: authenticatedUserId,
          });
          delete projected.tools;
          requestAdapter = provider.createRequestAdapter(projected as TRequest);
          streamAdapter = provider.createStreamAdapter(projected as TRequest);
        }
        const modelResultUpdates = activeAppaHook.getModelResultUpdates();
        if (modelResultUpdates.size > 0) {
          const presented = applyAppaOutcomeNotices(
            requestAdapter.toProviderRequest(),
            modelResultUpdates,
          );
          requestAdapter = provider.createRequestAdapter(presented);
          streamAdapter = provider.createStreamAdapter(presented);
        }
      } catch (error) {
        throw toAppaHookApiError(error);
      }
    }
    logger.debug(
      { resolvedAgentId },
      `[${providerName}Proxy] Checking usage limits`,
    );
    const limitViolation =
      await LimitValidationService.checkLimitsBeforeRequest({
        agentId: resolvedAgentId,
        userId,
        virtualKeyId,
        passthroughVirtualKeyId,
        environmentIdOverride: delegationBillingEnvironmentId,
      });

    if (limitViolation) {
      const [_refusalMessage, contentMessage, limitMetadata] = limitViolation;
      logger.info(
        { resolvedAgentId, reason: "token_cost_limit_exceeded" },
        `${providerName} request blocked due to token cost limit`,
      );
      // Preserve the proxy-compatible error envelope so chat clients can read
      // structured limit metadata. This is Archestra budget enforcement, not the
      // provider throttling traffic, so it must not look like a rate limit:
      // a 429 makes every LLM SDK auto-retry a block that cannot clear on retry,
      // and makes clients frame it as a provider limit ("not your usage limit").
      // 402 Payment Required is non-retryable in all SDKs and semantically a
      // budget stop. The Archestra-specific `type` plus the stable `code` keep
      // structured detection working.
      return reply.status(402).send({
        error: {
          message: contentMessage,
          type: "usage_limit_exceeded",
          code: "token_cost_limit_exceeded",
          usage_limit: limitMetadata
            ? {
                limit_type: limitMetadata.limitType,
                entity_type: limitMetadata.entityType,
              }
            : undefined,
        },
      });
    }
    logger.debug(
      { resolvedAgentId },
      `[${providerName}Proxy] Limit check passed`,
    );

    // Resolve the agent's organization once, to apply its configured default
    // discovered-tool guardrails to any tools persisted below.
    const organization = await OrganizationModel.getById(
      resolvedAgent.organizationId,
    );

    // Persist tools declared by client (only for llm_proxy agents)
    if (resolvedAgent.agentType === "llm_proxy") {
      const tools = requestAdapter.getTools();
      if (tools.length > 0) {
        logger.debug(
          { toolCount: tools.length },
          `[${providerName}Proxy] Processing tools from request`,
        );
        // Apply the org's configured default policies to every newly
        // discovered tool persisted below.
        await utils.tools.persistTools(
          tools.map((t) => ({
            toolName: t.name,
            toolParameters: t.inputSchema,
            toolDescription: t.description,
          })),
          resolvedAgentId,
          organization
            ? {
                invocationAction:
                  organization.defaultDiscoveredToolInvocationPolicy,
                resultAction: organization.defaultDiscoveredToolResultPolicy,
              }
            : undefined,
          { userId, externalAgentId },
        );
      }
    }

    // A client may mark a Claude id with a context variant (`…[1m]`). It names
    // the same model at the same price, so it is dropped for bookkeeping —
    // otherwise the request records a model no catalog lists, which can never be
    // priced. The request itself is forwarded with the id the client sent.
    const actualModel = stripClaudeContextVariantSuffix(
      requestAdapter.getModel(),
    );

    // Ensure a model entry exists for cost tracking
    const discovered = [
      await ModelModel.ensureModelExists(actualModel, providerName),
    ].filter((model) => model !== null);

    // Only a first sighting reaches here, so the registry fetch (cached) and the
    // update stay off the per-request path. Enrichment is best-effort: a model
    // that cannot be priced must not fail the request it arrived on.
    if (discovered.length > 0) {
      try {
        const modelsDevData = await modelsDevClient.fetchModelsFromApi();
        for (const model of discovered) {
          await enrichDiscoveredModel({ model, modelsDevData });
        }
      } catch (error) {
        logger.warn(
          {
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
          "Failed to enrich proxy-discovered models",
        );
      }
    }

    // Prepare SSE headers for lazy commitment if streaming.
    // We defer writeHead(200) until the first actual write so that if the
    // upstream provider call fails before any data is written, the proxy can
    // return a proper HTTP error status code (e.g. 429) instead of being
    // stuck with a 200. The AI SDK detects errors via HTTP status codes, so
    // this is critical for error propagation to clients like the chat UI.
    let sseHeaders: Record<string, string> | undefined;
    if (requestAdapter.isStreaming()) {
      logger.debug(
        `[${providerName}Proxy] Preparing streaming response headers (lazy commit)`,
      );
      sseHeaders = streamAdapter.getSSEHeaders();
    }

    // Helper to commit SSE headers before the first write.
    // Safe to call multiple times — only writes headers once.
    const ensureStreamHeaders = () => {
      if (sseHeaders && !reply.raw.headersSent) {
        reply.raw.writeHead(200, {
          ...sseHeaders,
          ...(reply.getHeaders() as Record<string, string>),
        });
        streamTiming.firstByteAt = Date.now();
      }
    };

    // Fetch the agent's teams (with labels) once. Used both for policy
    // evaluation context (trusted data) and for trace span team attributes.
    const teams =
      await AgentTeamModel.getTeamLabelInfoForAgent(resolvedAgentId);
    const teamIds = teams.map((team) => team.id);

    // Fetch the requesting user's teams (with labels) for trace span attributes.
    const userTeams = userId
      ? await TeamModel.getTeamLabelInfoForUser({
          userId,
          organizationId: resolvedAgent.organizationId,
        })
      : [];

    // Enforce per-team model restrictions before any upstream call. Checked on
    // the model actually being invoked (post cost-optimization rewrite), and
    // against the AUTHENTICATED identity only — `userTeams` above is derived
    // from `userId`, which a caller can seed with the X-Archestra-User-Id
    // header, so it must not decide access.
    const authenticatedUserTeamIds = !authenticatedUserId
      ? []
      : authenticatedUserId === userId
        ? userTeams.map((team) => team.id)
        : (
            await TeamModel.getTeamLabelInfoForUser({
              userId: authenticatedUserId,
              organizationId: resolvedAgent.organizationId,
            })
          ).map((team) => team.id);

    const modelTeamAccess = await utils.checkModelTeamAccess({
      provider: providerName,
      modelId: actualModel,
      organizationId: resolvedAgent.organizationId,
      authenticatedUserId,
      userTeamIds: authenticatedUserTeamIds,
    });
    if (!modelTeamAccess.allowed) {
      logger.info(
        {
          resolvedAgentId,
          userId,
          authenticatedUserId,
          actualModel,
          reason: "model_team_restricted",
        },
        `${providerName} request blocked: model is restricted to teams the caller is not part of`,
      );
      // Standard error envelope with a machine-readable `internal_code`
      // (mirrors the provider_auth_required block above) so SDK clients
      // surface a clear, non-retryable failure.
      return reply.status(403).send({
        error: {
          message: modelTeamAccess.message,
          type: "api_authorization_error",
          internal_code: "model_restricted_to_teams",
        },
      });
    }

    // Evaluate trusted data policies
    logger.debug(
      {
        resolvedAgentId,
        considerContextUntrusted: resolvedAgent.considerContextUntrusted,
        inheritedContextUntrusted,
      },
      `[${providerName}Proxy] Evaluating trusted data policies`,
    );

    // Map client-decorated gateway tool names (e.g. Claude Code's
    // `mcp__<gateway>__archestra__run_tool`) back to the platform's own names
    // before any guardrail evaluation — trusted-data and tool-invocation
    // lookups otherwise miss the real tool behind the decoration and the
    // dispatch wrapper.
    // The request's own tool list is passed in so the canonicalizer can learn
    // the client's label for the gateway when it is not a name this
    // organization knows — the label is free text typed at `claude mcp add`
    // time, and a label nothing matches used to leave every decorated name
    // untouched.
    const canonicalizeToolName =
      await utils.gatewayToolNames.buildGatewayToolNameCanonicalizer({
        organizationId: resolvedAgent.organizationId,
        declaredToolNames: utils.collectDeclaredToolNames(
          requestAdapter.getOriginalRequest(),
        ),
      });
    const declaredMcpToolTargets = new Map(
      utils.collectDeclaredMcpToolTargets(requestAdapter.getOriginalRequest()),
    );
    for (const [wireName, target] of nativeCodexIssuedMcpTargets) {
      declaredMcpToolTargets.set(wireName, target);
    }
    const commonMessages = canonicalizeCommonMessageToolNames(
      requestAdapter.getMessages(),
      canonicalizeToolName,
    );
    const effectiveConsiderContextUntrusted =
      resolvedAgent.considerContextUntrusted || inheritedContextUntrusted;
    const initialUntrustedReason = resolvedAgent.considerContextUntrusted
      ? UNSAFE_CONTEXT_BOUNDARY_REASON.agentConfiguredUntrusted
      : inheritedContextUntrusted
        ? UNSAFE_CONTEXT_BOUNDARY_REASON.inheritedFromParent
        : undefined;
    // Dual LLM progress delivery. A chat-loopback request carries a progress
    // channel header and receives structured events on the in-process bus,
    // which the chat turn renders as model-invisible analysis parts. Everyone
    // else gets protocol-level SSE keep-alive comments while an analysis
    // holds the stream idle. Narration text is never injected into the
    // stream: on chat-completions transports injected content shares the
    // model's implicit text stream and fuses into the assistant's answer.
    const dualLlmProgressChannelRaw =
      request.headers[DUAL_LLM_PROGRESS_CHANNEL_HEADER.toLowerCase()];
    const dualLlmProgressChannel =
      typeof dualLlmProgressChannelRaw === "string" &&
      dualLlmProgressChannelRaw.length > 0
        ? dualLlmProgressChannelRaw
        : undefined;
    const publishDualLlmEvent = dualLlmProgressChannel
      ? (event: DualLlmProgressEvent) =>
          dualLlmProgressBus.publish(dualLlmProgressChannel, event)
      : undefined;
    // Only on `text/event-stream`: the keep-alive is an SSE comment, which
    // the NDJSON and binary event-stream transports would surface as a parse
    // error rather than ignore. Those streams simply go without one.
    const writeDualLlmKeepAlive =
      !publishDualLlmEvent &&
      sseHeaders?.["Content-Type"]?.startsWith("text/event-stream")
        ? () => {
            ensureStreamHeaders();
            reply.raw.write(DUAL_LLM_KEEPALIVE_SSE_COMMENT);
          }
        : undefined;

    const {
      toolResultUpdates,
      contextIsTrusted,
      dualLlmAnalyses,
      unsafeContextBoundary,
    } = await utils.trustedData.evaluateIfContextIsTrusted({
      messages: commonMessages,
      agentId: resolvedAgentId,
      organizationId: resolvedAgent.organizationId,
      userId,
      considerContextUntrusted: effectiveConsiderContextUntrusted,
      policyContext: { teamIds, externalAgentId },
      onDualLlmStart: (info) => {
        writeDualLlmKeepAlive?.();
        publishDualLlmEvent?.({ kind: "start", ...info });
      },
      onDualLlmProgress: (progress) => {
        writeDualLlmKeepAlive?.();
        publishDualLlmEvent?.({ kind: "qa", ...progress });
      },
      // A failed analysis fails the request closed. Chat renders the failure
      // from the structured event; for other clients the message is written
      // as a text delta — safe here because the request errors out and no
      // model output follows that could fuse with it.
      onDualLlmError: (info) => {
        publishDualLlmEvent?.({ kind: "error", ...info });
        if (!publishDualLlmEvent && requestAdapter.isStreaming()) {
          ensureStreamHeaders();
          reply.raw.write(streamAdapter.formatTextDeltaSSE(info.message));
        }
      },
      onDualLlmComplete: (analysis, info) =>
        publishDualLlmEvent?.({
          kind: "complete",
          toolCallId: analysis.toolCallId,
          toolName: info.toolName,
          analysis,
          cached: info.cached,
        }),
      initialUntrustedReason,
    });

    // Apply tool result updates
    requestAdapter.applyToolResultUpdates(toolResultUpdates);

    logger.info(
      {
        resolvedAgentId,
        toolResultUpdatesCount: Object.keys(toolResultUpdates).length,
        contextIsTrusted,
      },
      "Messages filtered after trusted data evaluation",
    );

    // Apply TOON compression if enabled
    let toonStats: ToolCompressionStats = {
      tokensBefore: 0,
      tokensAfter: 0,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: false,
    };
    let toonSkipReason: ToonSkipReason | null = null;

    const shouldApplyToonCompression =
      await utils.toonConversion.shouldApplyToonCompression(resolvedAgentId);

    if (shouldApplyToonCompression) {
      toonStats = await requestAdapter.applyToonCompression(actualModel);
      if (!toonStats.hadToolResults) {
        toonSkipReason = "no_tool_results";
      } else if (!toonStats.wasEffective) {
        toonSkipReason = "not_effective";
      }
    } else {
      toonSkipReason = "not_enabled";
    }

    logger.info(
      {
        shouldApplyToonCompression,
        toonTokensBefore: toonStats.tokensBefore,
        toonTokensAfter: toonStats.tokensAfter,
        toonCostSavings: toonStats.costSavings,
        toonSkipReason,
      },
      `${providerName} proxy: tool results compression completed`,
    );

    // Read per-key base URL override from header, but ONLY from internal (localhost) requests.
    // External clients must NOT be able to set this header — it would be an SSRF vector
    // (attacker could redirect the proxy to arbitrary URLs like cloud metadata endpoints).
    const providerBaseUrlHeader =
      isLoopbackRequest(request) &&
      typeof headersForExtraction["x-archestra-provider-base-url"] === "string"
        ? headersForExtraction["x-archestra-provider-base-url"]
        : undefined;

    // Extract provider-specific headers to forward (e.g., anthropic-beta)
    // Type cast is necessary because this is a generic handler for multiple providers,
    // and only Anthropic has the anthropic-beta header in its type definition
    const headersToForward: Record<string, string> = {};
    const headersObj = headers as Record<string, unknown>;
    if (typeof headersObj["anthropic-beta"] === "string") {
      const baseUrlOverridden = Boolean(perKeyBaseUrl || providerBaseUrlHeader);
      if (
        shouldForwardAnthropicBeta(requestAdapter.getModel(), baseUrlOverridden)
      ) {
        headersToForward["anthropic-beta"] = headersObj["anthropic-beta"];
      } else {
        logger.info(
          { model: requestAdapter.getModel() },
          `[${providerName}Proxy] stripping anthropic-beta for non-Claude custom upstream`,
        );
      }
    }

    // Per-key extra HTTP headers (e.g. RBAC headers required by Kubeflow-style
    // gateways). Looked up by chat_api_key ID — set whenever the call resolved
    // through a DB-managed key (auth override, JWKS, virtual key). Raw-bearer
    // calls have no chat_api_key row, so no extra headers.
    let perKeyExtraHeaders: Record<string, string> | null = null;
    if (perKeyChatApiKeyId) {
      // Reuse the row when an earlier auth path already loaded it.
      perKeyProviderApiKeyRow ??=
        await LlmProviderApiKeyModel.findById(perKeyChatApiKeyId);
      const row = perKeyProviderApiKeyRow;
      perKeyExtraHeaders = row?.extraHeaders ?? null;
      if (!row) {
        logger.warn(
          { chatApiKeyId: perKeyChatApiKeyId },
          `[${providerName}Proxy] chat_api_key row not found for id`,
        );
      } else {
        logger.info(
          {
            chatApiKeyId: perKeyChatApiKeyId,
            headers: headerNamePeek(perKeyExtraHeaders),
          },
          `[${providerName}Proxy] loaded extra headers from db`,
        );
      }
    } else {
      logger.info(
        `[${providerName}Proxy] no chat_api_key id, skipping db header lookup`,
      );
    }
    // Merge per-key extra headers behind any provider-forwarded headers
    // (anthropic-beta etc.) so protocol-level headers always win.
    const mergedHeaders: Record<string, string> = {
      ...(perKeyExtraHeaders ?? {}),
      ...headersToForward,
    };
    // This is a proxy-to-client capability, never a provider request header.
    for (const headerName of Object.keys(mergedHeaders)) {
      if (
        headerName.toLowerCase() === APPA_SPAWN_BINDINGS_HEADER ||
        headerName.toLowerCase() === "x-archestra-appa-spawn-binding"
      ) {
        delete mergedHeaders[headerName];
      }
    }
    if (Object.keys(mergedHeaders).length > 0) {
      logger.info(
        { headers: headerNamePeek(mergedHeaders) },
        `[${providerName}Proxy] forwarding headers to provider`,
      );
    }

    const effectiveBaseUrl =
      perKeyBaseUrl || providerBaseUrlHeader || provider.getBaseUrl();

    assertSubscriptionCredentialForProvider({
      apiKey,
      provider: providerName,
    });

    // Start with the credential-derived billing mode. Anthropic OAuth requests
    // can refine this after the upstream response identifies paid overage.
    let billingMode = utils.resolveInteractionBillingMode({
      isSubscriptionCredential:
        provider.isSubscriptionCredential?.(apiKey) ?? false,
      autodetectEnabled: config.llmCost.subscriptionAutodetect,
    });

    // Create client with observability (each provider handles metrics internally)
    const abortSignal =
      providerName === "microsoft-365-copilot"
        ? createDownstreamAbortSignal({ request, reply })
        : undefined;
    const client = provider.createClient(apiKey, {
      baseUrl: effectiveBaseUrl,
      agent: resolvedAgent,
      abortSignal,
      source,
      model: requestAdapter.getModel(),
      defaultHeaders:
        Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
      llmProviderApiKeyId: perKeyChatApiKeyId,
      onResponseHeaders: (responseHeaders) => {
        if (providerName === "anthropic") {
          billingMode = utils.refineAnthropicBillingModeFromHeaders({
            billingMode,
            headers: responseHeaders,
          });
        }
      },
    });

    // Build final request
    const builtRequest =
      nativeCodexRequested && activeAppaHook
        ? await restoreNativeCodexProviderIds({
            session: activeAppaHook,
            request: requestAdapter.toProviderRequest(),
            principalUserId: authenticatedUserId,
          })
        : requestAdapter.toProviderRequest();

    // Repair unpaired UTF-16 surrogates before the body leaves for the
    // provider. Half a surrogate pair has no UTF-8 encoding, so a provider
    // rejects the entire request ("the request body is not valid JSON" on
    // Bedrock). Because the offending half usually sits in a *stored* turn that
    // every later turn replays, leaving it in place wedges the conversation for
    // good — the user's only escape is abandoning the history. We fix our own
    // producers at the source, but the transcript also carries text we never
    // shaped (third-party MCP tool output truncated mid-character, pasted
    // content), so this backstop is what keeps one bad character from costing a
    // conversation. Clean bodies pass through by reference and are not copied.
    const { value: repairedRequest, repaired: repairedSurrogates } =
      repairLoneSurrogates(builtRequest);
    if (repairedSurrogates > 0) {
      // Count only, never the text: this rides on user conversation content.
      logger.warn(
        {
          provider: providerName,
          agentId: resolvedAgent.id,
          organizationId: resolvedAgent.organizationId,
          repairedSurrogates,
        },
        `[${providerName}Proxy] Replaced unpaired surrogates in the outbound request body; the provider would have rejected it as malformed JSON`,
      );
    }
    const finalRequest = repairedRequest as TRequest;

    if (activeAppaHook) {
      try {
        await activeAppaHook.sendPrompt(finalRequest);
      } catch (error) {
        throw toAppaHookApiError(error);
      }
    }

    // Which called tool names count as available to evaluatePolicies, in the
    // canonical form tool-call names are compared in. Read from the request
    // body rather than `getTools()`, which keeps only schema-carrying function
    // tools: a tool the caller declared and executes itself (Anthropic's
    // bash/text_editor/computer, OpenAI chat `custom` tools, every non-function
    // tool on the Responses surface) is absent from that list, so every call to
    // one would be refused.
    //
    // Those names resolve to no `toolsTable` row, so no policy speaks for them
    // and this set is the only thing that could refuse them. Counting them
    // keeps them reachable, which is what the caller asked for by declaring
    // them, and leaves the client — which is the one executing them — as the
    // boundary that governs them.
    const enabledToolNames = new Set(
      [
        ...utils.collectDeclaredToolNames(requestAdapter.getOriginalRequest()),
        ...nativeCodexToolNames,
      ].map(canonicalizeToolName),
    );

    // A gateway tool name the client decorated with an alias the platform does
    // not recognize survives canonicalization untouched, and every guardrail
    // downstream then reasons about the decoration rather than the tool. That
    // degradation is otherwise completely silent, which is why it can sit in a
    // deployment indefinitely — so say so once per request, naming the tool, so
    // it is greppable and the gateway can be re-registered under the name the
    // connection-setup script derives (`toMcpClientServerName`).
    const unrecognizedGatewayToolNames = [...enabledToolNames].filter(
      (toolName) =>
        archestraMcpBranding.isLikelyToolName(toolName) &&
        !archestraMcpBranding.isToolName(toolName),
    );
    if (unrecognizedGatewayToolNames.length > 0) {
      logger.warn(
        {
          agentId: resolvedAgent.id,
          organizationId: resolvedAgent.organizationId,
          toolNames: unrecognizedGatewayToolNames,
        },
        `[${providerName}Proxy] Gateway tool names carry a client alias this organization does not know; guardrails cannot resolve the tools behind them`,
      );
    }

    // Convert headers to Record<string, string> for policy evaluation context
    const headersRecord: Record<string, string> = {};
    const rawHeaders = headers as Record<string, unknown>;
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string") {
        headersRecord[key] = value;
      }
    }

    const ctx: LLMProxyContext<TRequest> = {
      agent: resolvedAgent,
      originalRequest: requestAdapter.getOriginalRequest(),
      actualModel,
      contextIsTrusted,
      enabledToolNames,
      nativeCodexApplyPatch: nativeCodexToolNames.includes(
        "functions.apply_patch",
      ),
      nativeCodex: nativeCodexRequested,
      nativeCodexHistory,
      nativeCodexControl,
      appaNativeClient,
      nativeCodexGatewayPrincipals,
      authenticatedUserId,
      canonicalizeToolName,
      declaredMcpToolTargets,
      toonStats,
      toonSkipReason,
      dualLlmAnalyses,
      unsafeContextBoundary,
      suppressContent,
      lockedChat,
      delegationBillingEnvironmentId,
      appId: attributedAppId,
      externalAgentId,
      authMethod,
      billingMode,
      getBillingMode: () => billingMode,
      authenticatedApp,
      userId,
      resolvedUser,
      virtualKeyId,
      passthroughVirtualKeyId,
      sessionId,
      sessionSource,
      source,
      runId,
      parentContext,
      teamIds,
      teams,
      userTeams,
      streamTiming,
      appaHook: activeAppaHook,
      nativeClientTaskPath,
      nativeLogicalTaskPath,
    };

    // handleStreaming is self-contained: it persists its own failed-interaction
    // record and routes errors through handleError before its promise settles,
    // so it returns a bare promise (awaiting it here would double-persist via
    // the catch below).
    if (requestAdapter.isStreaming()) {
      return handleStreaming(
        client,
        finalRequest,
        reply,
        provider,
        streamAdapter,
        ctx,
        ensureStreamHeaders,
      );
    }
    // `return await`, not `return`: handleNonStreaming relies on THIS catch for
    // provider failures. A bare `return promise` inside try/catch lets the
    // rejection bypass the catch entirely — upstream failures then skip
    // handleError's status mapping (clients get a generic 500 instead of the
    // provider's 429/404/…), skip the failed-interaction record, and get
    // captured as unhandled server exceptions.
    return await handleNonStreaming(client, finalRequest, reply, provider, ctx);
  } catch (error) {
    let handledError = error;
    if (activeAppaHook) {
      try {
        await activeAppaHook.abort();
      } catch (abortError) {
        handledError = toAppaHookApiError(abortError);
      }
    }
    // Persist failed interactions so they appear in LLM logs
    try {
      const errorMessage = provider.extractErrorMessage(handledError);
      logger.info(
        { profileId: resolvedAgent.id, errorMessage },
        "Persisting error interaction record",
      );
      const record: InsertInteraction = {
        profileId: resolvedAgent.id,
        externalAgentId,
        runId,
        userId,
        virtualKeyId,
        passthroughVirtualKeyId,
        appId: attributedAppId,
        sessionId,
        sessionSource,
        source,
        authMethod,
        authenticatedAppId: authenticatedApp?.id,
        authenticatedAppName: authenticatedApp?.name,
        type: provider.interactionType,
        request: requestAdapter.getOriginalRequest() as InteractionRequest,
        processedRequest: null,
        response: { error: errorMessage },
        model: stripClaudeContextVariantSuffix(requestAdapter.getModel()),
        // Mirrors `model`, as every write path does now that nothing rewrites
        // the model in flight. This row carries no cost either way.
        baselineModel: stripClaudeContextVariantSuffix(
          requestAdapter.getModel(),
        ),
        inputTokens: 0,
        outputTokens: 0,
      };
      await persistProxyInteraction(
        record,
        lockedChat,
        delegationBillingEnvironmentId,
      );
    } catch (interactionError) {
      logger.error(
        { err: interactionError, profileId: resolvedAgent.id },
        "Failed to create error interaction record",
      );
    }

    return handleError(
      handledError,
      reply,
      provider.extractErrorMessage,
      requestAdapter.isStreaming(),
      provider.extractInternalCode.bind(provider),
      provider.formatStreamErrorFrame,
    );
  }
}

// =============================================================================
// STREAMING HANDLER
// =============================================================================

async function handleStreaming<
  TRequest,
  TResponse,
  TMessages,
  TChunk,
  THeaders,
>(
  client: unknown,
  request: TRequest,
  reply: FastifyReply,
  provider: LLMProvider<TRequest, TResponse, TMessages, TChunk, THeaders>,
  streamAdapter: LLMStreamAdapter<TChunk, TResponse>,
  ctx: LLMProxyContext<TRequest>,
  ensureStreamHeaders: () => void,
): Promise<FastifyReply> {
  const {
    agent,
    originalRequest,
    actualModel,
    contextIsTrusted,
    enabledToolNames,
    canonicalizeToolName,
    declaredMcpToolTargets,
    toonStats,
    toonSkipReason,
    dualLlmAnalyses,
    unsafeContextBoundary,
    suppressContent,
    lockedChat,
    delegationBillingEnvironmentId,
    appId,
    externalAgentId,
    authMethod,
    billingMode: initialBillingMode,
    getBillingMode,
    authenticatedApp,
    userId,
    virtualKeyId,
    passthroughVirtualKeyId,
    resolvedUser,
    sessionId,
    sessionSource,
    source,
    runId,
    parentContext,
    teamIds,
    teams,
    userTeams,
    appaHook,
    nativeCodex,
    nativeCodexHistory,
    nativeCodexControl,
    appaNativeClient,
    nativeCodexGatewayPrincipals,
    authenticatedUserId,
    nativeClientTaskPath,
    nativeLogicalTaskPath,
    streamTiming,
  } = ctx;

  const providerName = provider.provider;
  let billingMode = initialBillingMode;
  const streamStartTime = Date.now();
  let firstChunkTime: number | undefined;
  let streamCompleted = false;

  // Every byte to the client goes through here so the keep-alive knows when
  // the stream last spoke. The keep-alive itself only ever writes to a stream
  // that is already committed and idle (see StreamKeepAlive) — it is armed
  // now, before the upstream call, so it also covers a stream the dual-LLM
  // keep-alive committed during preflight and a slow post-stream policy
  // evaluation, but it cannot itself turn a pending upstream error into a 200.
  const keepAlive = new StreamKeepAlive(
    reply.raw,
    config.llmProxy.streamKeepAliveIntervalMs,
    streamAdapter
      .getSSEHeaders()
      ["Content-Type"]?.startsWith("text/event-stream") ?? false,
  );
  keepAlive.start();
  const writeToClient = (data: string | Uint8Array) => {
    ensureStreamHeaders();
    reply.raw.write(data);
    keepAlive.touch();
  };
  // Providers whose transport can't self-instrument duration (Bedrock) rely on
  // us to record llm_request_duration_seconds. Guard against a second (error-path)
  // observation once the stream has been established.
  let requestDurationRecorded = false;
  // The finally-block persist is gated on usage, so any stream that ends without
  // the provider ever reporting usage — a mid-stream failure, or a stream the
  // provider truncates cleanly — would otherwise leave no trace in LLM logs /
  // session history. Both paths funnel through here; the flag keeps a failed
  // stream from being recorded twice (the catch persists, then finally runs).
  let usagelessInteractionRecorded = false;
  const recordUsagelessInteraction = async (response: unknown) => {
    if (usagelessInteractionRecorded) {
      return;
    }
    usagelessInteractionRecorded = true;

    try {
      const record: InsertInteraction = {
        profileId: agent.id,
        externalAgentId,
        runId,
        userId,
        virtualKeyId,
        passthroughVirtualKeyId,
        appId,
        sessionId,
        sessionSource,
        source,
        authMethod,
        authenticatedAppId: authenticatedApp?.id,
        authenticatedAppName: authenticatedApp?.name,
        type: provider.interactionType,
        request: originalRequest as InteractionRequest,
        processedRequest: request as InteractionRequest,
        response: response as InteractionResponse,
        model: actualModel,
        inputTokens: 0,
        outputTokens: 0,
      };
      await persistProxyInteraction(
        record,
        lockedChat,
        delegationBillingEnvironmentId,
      );
    } catch (interactionError) {
      logger.error(
        { err: interactionError, profileId: agent.id },
        "Failed to create interaction record for stream without usage",
      );
    }
  };

  logger.debug(
    { model: actualModel },
    `[${providerName}Proxy] Starting streaming request`,
  );

  // Hoisted out of the try: the refusal is decided inside it, but the
  // interaction is written in the finally, and a row that does not say it was
  // refused is indistinguishable from a healthy one.
  let toolCallBlock: ToolCallBlock | undefined;
  // Hook-enabled streams cannot release provider bytes before the final tool
  // decision. Some provider chunks carry text and a tool call together.
  const bufferedFrames: Array<{
    data: string | Uint8Array;
    hasToolCall: boolean;
  }> = [];
  let hasUnsupportedAppaStreamToolCall = false;
  let appaStreamBytes = 0;

  try {
    // Execute streaming request with tracing — the span covers the full streaming
    // operation (request → all chunks consumed) so we can set response attributes
    await utils.tracing.startActiveLlmSpan({
      operationName: provider.spanName,
      provider: providerName,
      model: actualModel,
      stream: true,
      agent,
      teams,
      userTeams,
      sessionId,
      runId,
      externalAgentId,
      authMethod,
      virtualKeyId,
      passthroughVirtualKeyId,
      authenticatedApp,
      source,
      serverAddress: provider.getBaseUrl(),
      promptMessages: provider
        .createRequestAdapter(originalRequest)
        .getProviderMessages(),
      suppressContent,
      parentContext,
      user: toSpanUserInfo(resolvedUser),
      callback: async (llmSpan) => {
        const stream = await provider.executeStream(client, request);
        billingMode = getBillingMode();

        // Record request duration at stream establishment for providers whose
        // transport can't self-instrument it (Bedrock). This mirrors
        // getObservableFetch/getObservableGenAI, which observe duration when the
        // response/stream is established rather than when it finishes streaming.
        if (provider.recordRequestDurationInHandler) {
          metrics.llm.reportRequestDuration(
            providerName,
            agent,
            actualModel,
            (Date.now() - streamStartTime) / 1000,
            "200",
            source,
          );
          requestDurationRecorded = true;
        }

        // Process chunks

        for await (const chunk of stream) {
          // Track first chunk time
          if (!firstChunkTime) {
            firstChunkTime = Date.now();
            const ttftSeconds = (firstChunkTime - streamStartTime) / 1000;
            metrics.llm.reportTimeToFirstToken(
              providerName,
              agent,
              actualModel,
              ttftSeconds,
              source,
            );
          }

          if (appaHook) {
            // Bound the whole provider stream, including tool-only chunks that
            // the adapter stores without returning an SSE frame.
            appaStreamBytes += Buffer.byteLength(JSON.stringify(chunk) ?? "");
            if (appaStreamBytes > 16 * 1024 * 1024) {
              throw new ApiError(
                503,
                "OpenAPPA proxy stream exceeds the 16 MiB prototype limit.",
              );
            }
            if (
              hasUnsupportedOpenAiStreamToolCall(
                chunk,
                provider.interactionType,
              )
            ) {
              hasUnsupportedAppaStreamToolCall = true;
            }
          }

          const result = streamAdapter.processChunk(chunk);

          // An adapter reports a tool-call chunk by withholding `sseData`, so
          // the call accumulates and is released, or discarded, once
          // `evaluatePolicies` has run. Releasing one earlier would mean
          // predicting the gate's verdict from cheaper signals, and any
          // disagreement hands the client a runnable call the gate refused —
          // the MCP gateway's re-check resolves against the agent's assigned
          // tools and does not re-apply this turn's decision. A refusal covers
          // the whole batch too, so a call released before its siblings arrive
          // could not be taken back.
          //
          if (result.sseData) {
            if (appaHook) {
              bufferedFrames.push({
                data: result.sseData,
                hasToolCall: result.isToolCallChunk,
              });
            } else {
              writeToClient(result.sseData);
            }
          }

          if (result.isFinal) {
            break;
          }
        }

        // Set response attributes on span per OTEL GenAI semconv
        const { state } = streamAdapter;
        // Correct zero-input usage before any consumer (span cost, metrics, the
        // finally-block cost/persistence) reads it — they all share state.usage.
        if (state.usage) {
          const fallbackAdapter =
            provider.createRequestAdapter(originalRequest);
          state.usage = applyInputTokenFallback({
            usage: state.usage,
            provider: providerName,
            providerMessages: fallbackAdapter.getProviderMessages(),
            tools: fallbackAdapter.getTools(),
            model: actualModel,
          });
        }
        if (state.model) {
          llmSpan.setAttribute(ATTR_GENAI_RESPONSE_MODEL, state.model);
        }
        if (state.responseId) {
          llmSpan.setAttribute(ATTR_GENAI_RESPONSE_ID, state.responseId);
        }
        if (state.usage) {
          // Per the GenAI semconv, gen_ai.usage.input_tokens includes cached
          // tokens. Internally state.usage.inputTokens is uncached-only (cost,
          // metrics, and DB depend on that), so add cache read/write back for
          // the span attributes. The uncached value is still derivable as
          // input_tokens - cache_read.input_tokens - cache_creation.input_tokens.
          const totalInputTokens =
            state.usage.inputTokens +
            (state.usage.cacheReadTokens ?? 0) +
            (state.usage.cacheWriteTokens ?? 0);
          llmSpan.setAttribute(ATTR_GENAI_USAGE_INPUT_TOKENS, totalInputTokens);
          llmSpan.setAttribute(
            ATTR_GENAI_USAGE_OUTPUT_TOKENS,
            state.usage.outputTokens,
          );
          llmSpan.setAttribute(
            ATTR_GENAI_USAGE_TOTAL_TOKENS,
            totalInputTokens + state.usage.outputTokens,
          );
          if (state.usage.cacheReadTokens) {
            llmSpan.setAttribute(
              ATTR_GENAI_USAGE_CACHE_READ_INPUT_TOKENS,
              state.usage.cacheReadTokens,
            );
          }
          if (state.usage.cacheWriteTokens) {
            llmSpan.setAttribute(
              ATTR_GENAI_USAGE_CACHE_CREATION_INPUT_TOKENS,
              state.usage.cacheWriteTokens,
            );
          }
          if (state.usage.cacheWrite1hTokens) {
            llmSpan.setAttribute(
              ATTR_ARCHESTRA_USAGE_CACHE_CREATION_1H_INPUT_TOKENS,
              state.usage.cacheWrite1hTokens,
            );
          }
          if (state.usage.reasoningTokens) {
            llmSpan.setAttribute(
              ATTR_GENAI_USAGE_REASONING_OUTPUT_TOKENS,
              state.usage.reasoningTokens,
            );
          }
          const cost = await utils.costOptimization.calculateCost(
            actualModel,
            state.usage.inputTokens,
            state.usage.outputTokens,
            providerName,
            {
              readTokens: state.usage.cacheReadTokens,
              writeTokens: state.usage.cacheWriteTokens,
              write1hTokens: state.usage.cacheWrite1hTokens,
            },
          );
          if (cost !== undefined) {
            llmSpan.setAttribute(ATTR_ARCHESTRA_COST, cost);
            llmSpan.setAttribute(ATTR_ARCHESTRA_BILLING_MODE, billingMode);
          }
        }
        if (state.stopReason) {
          llmSpan.setAttribute(ATTR_GENAI_RESPONSE_FINISH_REASONS, [
            state.stopReason,
          ]);
        }

        // Capture streamed completion content (suppressed for locked chats)
        if (captureContent && !suppressContent && state.text) {
          llmSpan.addEvent(EVENT_GENAI_CONTENT_COMPLETION, {
            [ATTR_GENAI_COMPLETION]: state.text.slice(0, contentMaxLength),
          });
        }
      },
    });

    logger.info("Stream loop completed, processing final events");

    // Evaluate tool invocation policies
    const toolCalls = nativeCodex
      ? streamAdapter.state.toolCalls.map((call) => ({
          ...call,
          name: nativeCodexPolicyToolName(call.name),
        }))
      : streamAdapter.state.toolCalls;
    let toolInvocationRefusal: utils.toolInvocation.PolicyBlockResult | null =
      null;

    let rewrittenToolCalls: AccumulatedToolCall[] | null = null;
    let clientNativeToolCalls: AccumulatedToolCall[] | null = null;

    if (
      appaHook &&
      (hasUnsupportedAppaStreamToolCall ||
        hasUnsupportedFunctionToolCalls(toolCalls))
    ) {
      toolInvocationRefusal = appaUnsupportedToolCallBlock();
      toolCallBlock = toToolCallBlock(toolInvocationRefusal);
    } else if (toolCalls.length > 0) {
      rewrittenToolCalls = planDispatchRewrites({
        supported: streamAdapter.formatToolCallsSSE !== undefined,
        toolCalls,
        enabledToolNames,
        canonicalizeToolName,
        providerName,
      });

      logger.info(
        {
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map((tc) => tc.name),
        },
        "Evaluating tool invocation policies",
      );

      // Policies are evaluated against the rewritten calls, which
      // `normalizeToolCallsForPolicy` unwraps straight back to the same
      // targets — so a repaired call faces exactly the gate a `run_tool`
      // dispatch the model wrote itself would have faced.
      toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
        normalizeToolCallsForPolicy(
          rewrittenToolCalls ?? toolCalls,
          canonicalizeToolName,
        ),
        agent.id,
        {
          teamIds: teamIds ?? [],
          externalAgentId,
          sensitiveContextOrigin:
            utils.trustedData.sensitiveContextOriginFromBoundary(
              unsafeContextBoundary,
            ),
        },
        contextIsTrusted,
        enabledToolNames,
        { surface: "llm-proxy", sessionId: sessionId ?? undefined },
      );

      logger.info(
        { refused: !!toolInvocationRefusal },
        "Tool invocation policy result",
      );

      toolCallBlock = toToolCallBlock(toolInvocationRefusal);
    }

    if (
      !toolInvocationRefusal &&
      appaHook &&
      toolCalls.length > 0 &&
      !reply.raw.destroyed
    ) {
      let nativeFrameId: string | undefined;
      if (nativeCodex) {
        const prepared = await prepareNativeCodexCallAliases({
          session: appaHook,
          principalUserId: authenticatedUserId,
          gatewayPrincipals: nativeCodexGatewayPrincipals,
          request,
          response: streamAdapter.toProviderResponse(),
          calls: rewrittenToolCalls ?? toolCalls,
        });
        rewrittenToolCalls = prepared.calls;
        nativeFrameId = prepared.frameId;
      }
      const appaToolCalls = normalizeToolCallsForAppa(
        rewrittenToolCalls ?? toolCalls,
        canonicalizeToolName,
        declaredMcpToolTargets,
      );
      let heldBatchCommitted = false;
      if (nativeCodex && nativeCodexControl && nativeFrameId) {
        const held = await new AppaHeldResponseController().prepare({
          session: appaHook,
          heldFrameId: nativeFrameId,
          calls: appaToolCalls,
          organizationId: agent.organizationId,
          authenticatedUserId: nativeCodexControl.userId,
          controlNamespace: nativeCodexControl.namespace,
          boundThreadId: nativeCodexControl.threadId,
        });
        if (held.state === "held") {
          await persistHeldNativeHistory({
            session: appaHook,
            history: nativeCodexHistory,
            response: streamAdapter.toProviderResponse(),
          });
          const response = await restoreHeldNativeResponse({
            session: appaHook,
            heldFrameId: nativeFrameId,
            calls: [held.control],
          });
          ensureStreamHeaders();
          reply.raw.end(nativeCodexBootstrapSse(response));
          streamCompleted = true;
          return reply;
        }
        rewrittenToolCalls = held.calls.map((call) => ({
          id: call.id,
          name: call.emittedName,
          arguments: call.emittedArguments,
        }));
        heldBatchCommitted = true;
      }
      try {
        if (!heldBatchCommitted) {
          const effectiveCalls = await appaHook.authorizeOutboundToolCalls(
            appaToolCalls,
            nativeSpawnCarrierPreparation({
              session: appaHook,
              profileId: agent.id,
              client: appaNativeClient,
            }),
          );
          rewrittenToolCalls = effectiveCalls.map((call) => ({
            id: call.id,
            name: call.emittedName,
            arguments: call.emittedArguments,
          }));
        }
        if (
          nativeFrameId &&
          heldBatchCommitted &&
          appaToolCalls.some((call) => call.spawn)
        ) {
          throw new AppaProxySessionProtocolError(
            "native spawn aliases require held-batch prepublication support",
          );
        }
        if (nativeFrameId && !heldBatchCommitted) {
          await commitNativeCodexCalls({
            session: appaHook,
            frameId: nativeFrameId,
            calls: rewrittenToolCalls ?? toolCalls,
          });
          rewrittenToolCalls = await publishNativeChildSpawnAliases({
            session: appaHook,
            frameId: nativeFrameId,
            calls: rewrittenToolCalls ?? toolCalls,
            clientParentTaskPath: nativeClientTaskPath,
            logicalParentTaskPath: nativeLogicalTaskPath,
          });
          await issueNativeCodexFrame({
            session: appaHook,
            frameId: nativeFrameId,
          });
        }
        if (nativeCodex && rewrittenToolCalls) {
          clientNativeToolCalls = await restoreNativeCodexClientProcessCalls({
            scope: appaHook.getNativeWireScope(),
            calls: rewrittenToolCalls,
          });
        }
        exposeAppaSpawnBindings({ reply, appaHook });
        if (reply.raw.destroyed) {
          await appaHook.quarantineUndeliveredCalls();
          throw new AppaProxyHookError("unavailable", "outbound");
        }
      } catch (error) {
        if (error instanceof AppaProxyHookError && error.kind === "denied") {
          toolInvocationRefusal = appaHookPolicyBlock(appaToolCalls);
          toolCallBlock = toToolCallBlock(toolInvocationRefusal);
        } else {
          await appaHook.quarantineUndeliveredCalls();
          throw toAppaHookApiError(error);
        }
      }
    }

    // Freeze the post-authorization response before the durable completion is
    // sealed. The same state later drives the emitted SSE, so no mutation can
    // change executable arguments after APPA authorizes and attests them.
    const providerResponseForFrame = streamAdapter.toProviderResponse();
    if (rewrittenToolCalls) {
      streamAdapter.state.toolCalls.splice(
        0,
        streamAdapter.state.toolCalls.length,
        ...rewrittenToolCalls,
      );
    }
    const clientResponseForFrame = nativeCodex
      ? finalizeStreamClientResponse({
          providerResponse: providerResponseForFrame,
          clientNativeToolCalls,
          rewrittenToolCalls,
        })
      : streamAdapter.toProviderResponse();

    if (appaHook) {
      try {
        const awaitingClientToolExecution =
          !toolInvocationRefusal &&
          (rewrittenToolCalls ?? toolCalls).length > 0;
        const awaitingClientToolSearch =
          nativeCodex && hasNativeCodexToolSearch(providerResponseForFrame);
        if (
          nativeCodex &&
          !toolInvocationRefusal &&
          awaitingClientToolSearch &&
          !awaitingClientToolExecution
        ) {
          const prepared = await prepareNativeCodexCallAliases({
            session: appaHook,
            principalUserId: authenticatedUserId,
            gatewayPrincipals: nativeCodexGatewayPrincipals,
            request,
            response: providerResponseForFrame,
            calls: [],
          });
          await issueNativeCodexFrame({
            session: appaHook,
            frameId: prepared.frameId,
          });
        }
        await appaHook.finish({
          childReturn: streamAdapter.state.text,
          beforeRelease:
            !toolInvocationRefusal && awaitingClientToolExecution && nativeCodex
              ? () =>
                  persistPendingNativeCodexHistory({
                    history: nativeCodexHistory,
                    response: providerResponseForFrame,
                  })
              : !toolInvocationRefusal && !awaitingClientToolExecution
                ? () =>
                    persistAppaCompletedResponse({
                      session: appaHook,
                      profileId: agent.id,
                      provider: providerName,
                      protocol: appaHistoryProtocol(provider.interactionType),
                      model: actualModel,
                      request,
                      clientResponse: clientResponseForFrame,
                      providerResponse: providerResponseForFrame,
                      nativeCodexHistory,
                    })
                : undefined,
        });
        appaHook.markContinuationResponseReady();
      } catch (error) {
        throw toAppaHookApiError(error);
      }
    }

    if (
      appaHook &&
      nativeCodex &&
      !toolInvocationRefusal &&
      !reply.raw.destroyed
    ) {
      ensureStreamHeaders();
      reply.raw.end(
        nativeCodexBootstrapSse(
          clientResponseForFrame as Record<string, unknown>,
        ),
      );
      streamCompleted = true;
      return reply;
    }
    if (appaHook && !toolInvocationRefusal && !reply.raw.destroyed) {
      const safeFrames = bufferedFrames.filter((frame) => !frame.hasToolCall);
      if (safeFrames.length > 0) {
        ensureStreamHeaders();
        for (const frame of safeFrames) {
          reply.raw.write(frame.data);
        }
      }
    }

    if (toolInvocationRefusal) {
      const { contentMessage, reason, allToolCallNames } =
        toolInvocationRefusal;

      // The tool-call events were held back, so they are simply dropped and
      // the client is sent the refusal alone.
      const refusalEvents = streamAdapter.formatCompleteTextSSE(contentMessage);
      for (const event of refusalEvents) {
        writeToClient(event);
      }

      recordBlockedToolCallMetrics({
        allToolCallNames,
        reason,
        agent,
        teams,
        userTeams,
        sessionId,
        resolvedUser,
        providerName,
        toolCallCount: toolCalls.length,
        actualModel,
        source,
      });
    } else if (toolCalls.length > 0) {
      // Policy allowed them, so hand the buffered events over now. Read once:
      // getRawToolCallEvents must not be called in a condition and again for
      // the flush, or a snapshot-per-call adapter would still work but a
      // draining one would silently discard events. Reading is also what tells
      // the adapter these calls became the client's, so a turn whose client
      // already hung up must not read at all — the write would go to a closed
      // socket and the reconstructed turn would claim a delivery.
      if (!reply.raw.destroyed) {
        // A repaired batch replaces the buffered events wholesale: the raw
        // fragments still name the tool the model called directly, which is the
        // call the client cannot execute. `state.toolCalls` is updated to match
        // what actually went out, so the persisted interaction and
        // `toProviderResponse()` describe the turn the client saw rather than
        // the one the model first wrote.
        const allEvents =
          rewrittenToolCalls && streamAdapter.formatToolCallsSSE
            ? streamAdapter.formatToolCallsSSE(rewrittenToolCalls)
            : streamAdapter.getRawToolCallEvents();
        if (rewrittenToolCalls) {
          streamAdapter.state.toolCalls.splice(
            0,
            streamAdapter.state.toolCalls.length,
            ...rewrittenToolCalls,
          );
        }
        for (const event of allEvents) {
          writeToClient(event);
        }
      }
    }

    // Stream end events
    writeToClient(streamAdapter.formatEndSSE());
    reply.raw.end();

    streamCompleted = true;
    return reply;
  } catch (error) {
    let handledError = error;
    if (appaHook) {
      try {
        await appaHook.abort();
      } catch (abortError) {
        handledError = toAppaHookApiError(abortError);
      }
    }
    // If the stream never established (e.g. a provider 400 rejecting the
    // request), record the duration here for providers we instrument in the
    // handler. A mid-stream error is not double-recorded: establishment already
    // set the flag, matching the "duration = time to establishment" semantics.
    if (provider.recordRequestDurationInHandler && !requestDurationRecorded) {
      metrics.llm.reportRequestDuration(
        providerName,
        agent,
        actualModel,
        (Date.now() - streamStartTime) / 1000,
        extractDurationStatusCode(handledError),
        source,
      );
      requestDurationRecorded = true;
    }

    // A stream that fails before any usage arrives (e.g. a provider 400
    // rejecting the request, or a mid-stream failure once SSE headers and
    // content are already on the wire) still has to reach interaction history.
    if (!streamAdapter.state.usage) {
      const errorMessage = provider.extractErrorMessage(handledError);
      logger.info(
        { profileId: agent.id, errorMessage },
        "Persisting error interaction record for failed stream",
      );
      await recordUsagelessInteraction({ error: errorMessage });
    }

    return handleError(
      handledError,
      reply,
      provider.extractErrorMessage,
      true,
      provider.extractInternalCode.bind(provider),
      provider.formatStreamErrorFrame,
    );
  } finally {
    keepAlive.stop();

    // Always record interaction (whether stream completed or was aborted)
    if (!streamCompleted) {
      logger.info(
        "Stream was aborted before completion, recording partial interaction",
      );
    }

    // Client-visible first byte, preflight included. Observed here rather
    // than at commit time because the commit can happen during preflight
    // (dual-LLM keep-alive), before the handler has the labels in hand.
    if (streamTiming.firstByteAt !== undefined) {
      metrics.llm.reportTimeToFirstByte(
        providerName,
        agent,
        actualModel,
        (streamTiming.firstByteAt - streamTiming.requestReceivedAt) / 1000,
        source,
      );
    }

    const usage = streamAdapter.state.usage;
    if (usage) {
      withSessionContext(sessionId, () => {
        metrics.llm.reportLLMTokens(
          providerName,
          agent,
          {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cacheRead: usage.cacheReadTokens,
            cacheWrite: usage.cacheWriteTokens,
          },
          actualModel,
          source,
        );

        if (usage.outputTokens && firstChunkTime) {
          const totalDurationSeconds = (Date.now() - streamStartTime) / 1000;
          metrics.llm.reportTokensPerSecond(
            providerName,
            agent,
            actualModel,
            usage.outputTokens,
            totalDurationSeconds,
            source,
          );
        }
      });

      const costs = await calculateInteractionCosts({
        actualModel,
        usage,
        providerName,
      });

      withSessionContext(sessionId, () => {
        metrics.llm.reportLLMCost({
          provider: providerName,
          profile: agent,
          model: actualModel,
          cost: costs.actualCost,
          source,
          billingMode,
          authMethod,
        });
        metrics.llm.reportLLMCacheCost(
          providerName,
          agent,
          actualModel,
          {
            cacheCost: costs.cacheCost,
            cacheReadSavings: costs.cacheReadSavings,
          },
          source,
        );
      });

      try {
        const record = buildInteractionRecord({
          agent,
          externalAgentId,
          authMethod,
          billingMode,
          authenticatedApp,
          runId,
          userId,
          virtualKeyId,
          passthroughVirtualKeyId,
          appId,
          sessionId,
          sessionSource,
          source,
          providerType: provider.interactionType,
          request: originalRequest,
          processedRequest: request,
          response: streamAdapter.toProviderResponse(),
          actualModel,
          usage,
          costs,
          toonStats,
          toonSkipReason,
          dualLlmAnalyses,
          unsafeContextBoundary,
          toolCallBlock,
        });
        await persistProxyInteraction(
          record,
          lockedChat,
          delegationBillingEnvironmentId,
        );
      } catch (interactionError) {
        logger.error(
          { err: interactionError, profileId: agent.id },
          "Failed to create interaction record (agent may have been deleted)",
        );
      }
    } else {
      // No usage ever arrived. On the error path the catch has already recorded
      // the failure; otherwise the provider ended the stream early (a truncated
      // response), and the partial content is all we have to log. Either way the
      // call must not disappear from interaction history.
      await recordUsagelessInteraction(streamAdapter.toProviderResponse());
    }
  }
}

// =============================================================================
// NON-STREAMING HANDLER
// =============================================================================

async function handleNonStreaming<
  TRequest,
  TResponse,
  TMessages,
  TChunk,
  THeaders,
>(
  client: unknown,
  request: TRequest,
  reply: FastifyReply,
  provider: LLMProvider<TRequest, TResponse, TMessages, TChunk, THeaders>,
  ctx: LLMProxyContext<TRequest>,
): Promise<FastifyReply> {
  const {
    agent,
    originalRequest,
    actualModel,
    contextIsTrusted,
    enabledToolNames,
    nativeCodexApplyPatch,
    nativeCodex,
    nativeCodexHistory,
    nativeClientTaskPath,
    nativeLogicalTaskPath,
    canonicalizeToolName,
    declaredMcpToolTargets,
    toonStats,
    toonSkipReason,
    dualLlmAnalyses,
    unsafeContextBoundary,
    suppressContent,
    lockedChat,
    delegationBillingEnvironmentId,
    appId,
    externalAgentId,
    authMethod,
    billingMode: initialBillingMode,
    getBillingMode,
    authenticatedApp,
    userId,
    virtualKeyId,
    passthroughVirtualKeyId,
    resolvedUser,
    sessionId,
    sessionSource,
    source,
    runId,
    parentContext,
    teamIds,
    teams,
    userTeams,
    appaHook,
    nativeCodexControl,
    appaNativeClient,
    nativeCodexGatewayPrincipals,
    authenticatedUserId,
  } = ctx;

  const providerName = provider.provider;
  // Legacy compaction participates in APPA and opaque-history validation, but
  // it is not a native model response to alias or project into tool wire state.
  const nativeCodexWire =
    nativeCodex && nativeCodexHistory?.mode !== "compactv1";
  let billingMode = initialBillingMode;
  const requestStartTime = Date.now();

  logger.debug(
    { model: actualModel },
    `[${providerName}Proxy] Starting non-streaming request`,
  );

  // Execute request with tracing
  const { responseAdapter, usage } = await utils.tracing.startActiveLlmSpan({
    operationName: provider.spanName,
    provider: providerName,
    model: actualModel,
    stream: false,
    agent,
    teams,
    userTeams,
    sessionId,
    runId,
    externalAgentId,
    authMethod,
    virtualKeyId,
    passthroughVirtualKeyId,
    authenticatedApp,
    source,
    serverAddress: provider.getBaseUrl(),
    promptMessages: provider
      .createRequestAdapter(originalRequest)
      .getProviderMessages(),
    suppressContent,
    parentContext,
    user: toSpanUserInfo(resolvedUser),
    callback: async (llmSpan) => {
      // Record request duration for providers we instrument in the handler
      // (Bedrock). getObservableFetch covers the fetch-based providers, so those
      // must not double-report here — the flag gates that.
      let result: TResponse;
      try {
        result = await provider.execute(client, request);
        billingMode = getBillingMode();
      } catch (error) {
        if (provider.recordRequestDurationInHandler) {
          metrics.llm.reportRequestDuration(
            providerName,
            agent,
            actualModel,
            (Date.now() - requestStartTime) / 1000,
            extractDurationStatusCode(error),
            source,
          );
        }
        throw error;
      }
      if (provider.recordRequestDurationInHandler) {
        metrics.llm.reportRequestDuration(
          providerName,
          agent,
          actualModel,
          (Date.now() - requestStartTime) / 1000,
          "200",
          source,
        );
      }
      const adapter = provider.createResponseAdapter(result);

      // Set response attributes on span per OTEL GenAI semconv. Correct zero-input
      // usage here so the span cost and the downstream cost/persistence (which
      // reuse this usage) all see the estimate.
      const fallbackAdapter = provider.createRequestAdapter(originalRequest);
      const usage = applyInputTokenFallback({
        usage: adapter.getUsage(),
        provider: providerName,
        providerMessages: fallbackAdapter.getProviderMessages(),
        tools: fallbackAdapter.getTools(),
        model: actualModel,
      });
      llmSpan.setAttribute(ATTR_GENAI_RESPONSE_MODEL, adapter.getModel());
      llmSpan.setAttribute(ATTR_GENAI_RESPONSE_ID, adapter.getId());
      // Per the GenAI semconv, gen_ai.usage.input_tokens includes cached tokens.
      // Internally usage.inputTokens is uncached-only (cost, metrics, and DB
      // depend on that), so add cache read/write back for the span attributes.
      // The uncached value is still derivable as input_tokens -
      // cache_read.input_tokens - cache_creation.input_tokens.
      const totalInputTokens =
        usage.inputTokens +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0);
      llmSpan.setAttribute(ATTR_GENAI_USAGE_INPUT_TOKENS, totalInputTokens);
      llmSpan.setAttribute(ATTR_GENAI_USAGE_OUTPUT_TOKENS, usage.outputTokens);
      llmSpan.setAttribute(
        ATTR_GENAI_USAGE_TOTAL_TOKENS,
        totalInputTokens + usage.outputTokens,
      );
      if (usage.cacheReadTokens) {
        llmSpan.setAttribute(
          ATTR_GENAI_USAGE_CACHE_READ_INPUT_TOKENS,
          usage.cacheReadTokens,
        );
      }
      if (usage.cacheWriteTokens) {
        llmSpan.setAttribute(
          ATTR_GENAI_USAGE_CACHE_CREATION_INPUT_TOKENS,
          usage.cacheWriteTokens,
        );
      }
      if (usage.cacheWrite1hTokens) {
        llmSpan.setAttribute(
          ATTR_ARCHESTRA_USAGE_CACHE_CREATION_1H_INPUT_TOKENS,
          usage.cacheWrite1hTokens,
        );
      }
      if (usage.reasoningTokens) {
        llmSpan.setAttribute(
          ATTR_GENAI_USAGE_REASONING_OUTPUT_TOKENS,
          usage.reasoningTokens,
        );
      }
      const cost = await utils.costOptimization.calculateCost(
        actualModel,
        usage.inputTokens,
        usage.outputTokens,
        providerName,
        {
          readTokens: usage.cacheReadTokens,
          writeTokens: usage.cacheWriteTokens,
          write1hTokens: usage.cacheWrite1hTokens,
        },
      );
      if (cost !== undefined) {
        llmSpan.setAttribute(ATTR_ARCHESTRA_COST, cost);
        llmSpan.setAttribute(ATTR_ARCHESTRA_BILLING_MODE, billingMode);
      }
      llmSpan.setAttribute(
        ATTR_GENAI_RESPONSE_FINISH_REASONS,
        adapter.getFinishReasons(),
      );

      // Capture completion content (suppressed for locked chats)
      if (captureContent && !suppressContent) {
        const text = adapter.getText?.();
        if (text) {
          llmSpan.addEvent(EVENT_GENAI_CONTENT_COMPLETION, {
            [ATTR_GENAI_COMPLETION]: text.slice(0, contentMaxLength),
          });
        }
      }

      return { response: result, responseAdapter: adapter, usage };
    },
  });

  const toolCalls = responseAdapter
    .getToolCalls()
    .map((call) =>
      nativeCodexWire
        ? { ...call, name: nativeCodexPolicyToolName(call.name) }
        : call,
    );
  logger.debug(
    { toolCallCount: toolCalls.length },
    `[${providerName}Proxy] Non-streaming response received, checking tool invocation policies`,
  );

  // Evaluate tool invocation policies
  let rewrittenToolCalls: AccumulatedToolCall[] | null = null;
  let clientNativeToolCalls: AccumulatedToolCall[] | null = null;
  let toolInvocationRefusal: utils.toolInvocation.PolicyBlockResult | null =
    null;
  const appaUnsupportedResponse =
    appaHook &&
    (hasUnsupportedOpenAiResponseToolCall(
      responseAdapter.getOriginalResponse(),
      provider.interactionType,
    ) ||
      hasUnsupportedFunctionToolCalls(
        toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        })),
      ));
  if (toolCalls.length > 0 || appaUnsupportedResponse) {
    if (appaUnsupportedResponse) {
      toolInvocationRefusal = appaUnsupportedToolCallBlock();
    } else {
      rewrittenToolCalls = planDispatchRewrites({
        supported: responseAdapter.withRewrittenToolCalls !== undefined,
        toolCalls: toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        })),
        enabledToolNames,
        canonicalizeToolName,
        providerName,
      });

      toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
        normalizeToolCallsForPolicy(
          rewrittenToolCalls ??
            toolCalls.map((toolCall) => ({
              name: toolCall.name,
              arguments: toolCall.arguments,
            })),
          canonicalizeToolName,
        ),
        agent.id,
        {
          teamIds: teamIds ?? [],
          externalAgentId,
          sensitiveContextOrigin:
            utils.trustedData.sensitiveContextOriginFromBoundary(
              unsafeContextBoundary,
            ),
        },
        contextIsTrusted,
        enabledToolNames,
        { surface: "llm-proxy", sessionId: sessionId ?? undefined },
      );

      if (!toolInvocationRefusal && appaHook) {
        let nativeFrameId: string | undefined;
        if (nativeCodexWire) {
          const prepared = await prepareNativeCodexCallAliases({
            session: appaHook,
            principalUserId: authenticatedUserId,
            gatewayPrincipals: nativeCodexGatewayPrincipals,
            request,
            response: responseAdapter.getOriginalResponse(),
            calls:
              rewrittenToolCalls ??
              toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              })),
          });
          rewrittenToolCalls = prepared.calls;
          nativeFrameId = prepared.frameId;
        }
        const appaToolCalls = normalizeToolCallsForAppa(
          rewrittenToolCalls ??
            toolCalls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments),
            })),
          canonicalizeToolName,
          declaredMcpToolTargets,
        );
        let heldBatchCommitted = false;
        if (nativeCodexWire && nativeCodexControl && nativeFrameId) {
          const held = await new AppaHeldResponseController().prepare({
            session: appaHook,
            heldFrameId: nativeFrameId,
            calls: appaToolCalls,
            organizationId: agent.organizationId,
            authenticatedUserId: nativeCodexControl.userId,
            controlNamespace: nativeCodexControl.namespace,
            boundThreadId: nativeCodexControl.threadId,
          });
          if (held.state === "held") {
            await persistHeldNativeHistory({
              session: appaHook,
              history: nativeCodexHistory,
              response: responseAdapter.getOriginalResponse(),
            });
            return reply.send(
              await restoreHeldNativeResponse({
                session: appaHook,
                heldFrameId: nativeFrameId,
                calls: [held.control],
              }),
            );
          }
          rewrittenToolCalls = held.calls.map((call) => ({
            id: call.id,
            name: call.emittedName,
            arguments: call.emittedArguments,
          }));
          heldBatchCommitted = true;
        }
        try {
          if (!heldBatchCommitted) {
            const effectiveCalls = await appaHook.authorizeOutboundToolCalls(
              appaToolCalls,
              nativeSpawnCarrierPreparation({
                session: appaHook,
                profileId: agent.id,
                client: appaNativeClient,
              }),
            );
            rewrittenToolCalls = effectiveCalls.map((call) => ({
              id: call.id,
              name: call.emittedName,
              arguments: call.emittedArguments,
            }));
          }
          if (
            nativeFrameId &&
            heldBatchCommitted &&
            appaToolCalls.some((call) => call.spawn)
          ) {
            throw new AppaProxySessionProtocolError(
              "native spawn aliases require held-batch prepublication support",
            );
          }
          if (nativeFrameId && !heldBatchCommitted) {
            await commitNativeCodexCalls({
              session: appaHook,
              frameId: nativeFrameId,
              calls:
                rewrittenToolCalls ??
                toolCalls.map((toolCall) => ({
                  id: toolCall.id,
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.arguments),
                })),
            });
            rewrittenToolCalls = await publishNativeChildSpawnAliases({
              session: appaHook,
              frameId: nativeFrameId,
              calls:
                rewrittenToolCalls ??
                toolCalls.map((toolCall) => ({
                  id: toolCall.id,
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.arguments),
                })),
              clientParentTaskPath: nativeClientTaskPath,
              logicalParentTaskPath: nativeLogicalTaskPath,
            });
            await issueNativeCodexFrame({
              session: appaHook,
              frameId: nativeFrameId,
            });
          }
          if (nativeCodexWire && rewrittenToolCalls) {
            clientNativeToolCalls = await restoreNativeCodexClientProcessCalls({
              scope: appaHook.getNativeWireScope(),
              calls: rewrittenToolCalls,
            });
          }
          exposeAppaSpawnBindings({ reply, appaHook });
          if (reply.raw.destroyed) {
            await appaHook.quarantineUndeliveredCalls();
            throw new AppaProxyHookError("unavailable", "outbound");
          }
        } catch (error) {
          if (error instanceof AppaProxyHookError && error.kind === "denied") {
            toolInvocationRefusal = appaHookPolicyBlock(appaToolCalls);
          } else {
            await appaHook.quarantineUndeliveredCalls();
            throw toAppaHookApiError(error);
          }
        }
      }
    }

    const finalClientResponse =
      nativeCodexWire && clientNativeToolCalls
        ? rewriteNativeCodexResponseForClient(
            replaceNativeCodexCallItems(
              responseAdapter.getOriginalResponse(),
              clientNativeToolCalls,
            ),
          )
        : nativeCodexWire && rewrittenToolCalls
          ? rewriteNativeCodexResponseForClient(
              replaceNativeCodexCallItems(
                responseAdapter.getOriginalResponse(),
                rewrittenToolCalls,
              ),
            )
          : rewrittenToolCalls && responseAdapter.withRewrittenToolCalls
            ? responseAdapter.withRewrittenToolCalls(rewrittenToolCalls)
            : responseAdapter.getOriginalResponse();

    if (appaHook) {
      try {
        const awaitingClientToolExecution =
          !toolInvocationRefusal &&
          (rewrittenToolCalls ?? toolCalls).length > 0;
        await appaHook.finish({
          childReturn: responseAdapter.getText?.(),
          beforeRelease:
            !toolInvocationRefusal &&
            awaitingClientToolExecution &&
            nativeCodexWire
              ? () =>
                  persistPendingNativeCodexHistory({
                    history: nativeCodexHistory,
                    response: responseAdapter.getOriginalResponse(),
                  })
              : !toolInvocationRefusal && !awaitingClientToolExecution
                ? () =>
                    persistAppaCompletedResponse({
                      session: appaHook,
                      profileId: agent.id,
                      provider: providerName,
                      protocol: appaHistoryProtocol(provider.interactionType),
                      model: actualModel,
                      request,
                      clientResponse: finalClientResponse,
                      providerResponse: responseAdapter.getOriginalResponse(),
                      nativeCodexHistory,
                    })
                : undefined,
        });
        appaHook.markContinuationResponseReady();
      } catch (error) {
        throw toAppaHookApiError(error);
      }
    }

    if (toolInvocationRefusal) {
      const { refusalMessage, contentMessage, reason, allToolCallNames } =
        toolInvocationRefusal;
      logger.debug(
        { toolCallCount: toolCalls.length },
        `[${providerName}Proxy] Tool invocation blocked by policy`,
      );

      const refusalResponse = responseAdapter.toRefusalResponse(
        refusalMessage,
        contentMessage,
      );

      recordBlockedToolCallMetrics({
        allToolCallNames,
        reason,
        agent,
        teams,
        userTeams,
        sessionId,
        resolvedUser,
        providerName,
        toolCallCount: toolCalls.length,
        actualModel,
        source,
      });

      // Record interaction with refusal (usage already corrected above)
      const costs = await calculateInteractionCosts({
        actualModel,
        usage,
        providerName,
      });

      withSessionContext(sessionId, () => {
        metrics.llm.reportLLMCost({
          provider: providerName,
          profile: agent,
          model: actualModel,
          cost: costs.actualCost,
          source,
          billingMode,
          authMethod,
        });
        metrics.llm.reportLLMCacheCost(
          providerName,
          agent,
          actualModel,
          {
            cacheCost: costs.cacheCost,
            cacheReadSavings: costs.cacheReadSavings,
          },
          source,
        );
      });

      const refusalRecord = buildInteractionRecord({
        agent,
        externalAgentId,
        authMethod,
        billingMode,
        authenticatedApp,
        runId,
        userId,
        virtualKeyId,
        passthroughVirtualKeyId,
        appId,
        sessionId,
        sessionSource,
        source,
        providerType: provider.interactionType,
        request: originalRequest,
        processedRequest: request,
        response: refusalResponse,
        actualModel,
        usage,
        costs,
        toonStats,
        toonSkipReason,
        dualLlmAnalyses,
        unsafeContextBoundary,
        toolCallBlock: toToolCallBlock(toolInvocationRefusal),
      });
      await persistProxyInteraction(
        refusalRecord,
        lockedChat,
        delegationBillingEnvironmentId,
      );

      return reply.send(refusalResponse);
    }
  }

  const clientResponseBeforeNativeWire =
    nativeCodexWire && clientNativeToolCalls
      ? replaceNativeCodexCallItems(
          responseAdapter.getOriginalResponse(),
          clientNativeToolCalls,
        )
      : nativeCodexWire && rewrittenToolCalls
        ? replaceNativeCodexCallItems(
            responseAdapter.getOriginalResponse(),
            rewrittenToolCalls,
          )
        : rewrittenToolCalls && responseAdapter.withRewrittenToolCalls
          ? responseAdapter.withRewrittenToolCalls(rewrittenToolCalls)
          : responseAdapter.getOriginalResponse();
  const clientResponse =
    nativeCodexWire || nativeCodexApplyPatch
      ? rewriteNativeCodexResponseForClient(clientResponseBeforeNativeWire)
      : clientResponseBeforeNativeWire;

  if (toolCalls.length === 0 && appaHook) {
    try {
      if (nativeCodexWire) {
        const prepared = await prepareNativeCodexCallAliases({
          session: appaHook,
          request,
          response: responseAdapter.getOriginalResponse(),
          calls: [],
        });
        await issueNativeCodexFrame({
          session: appaHook,
          frameId: prepared.frameId,
        });
      }
      await appaHook.finish({
        childReturn: responseAdapter.getText?.(),
        beforeRelease: () =>
          persistAppaCompletedResponse({
            session: appaHook,
            profileId: agent.id,
            provider: providerName,
            protocol: appaHistoryProtocol(provider.interactionType),
            model: actualModel,
            request,
            clientResponse,
            providerResponse: responseAdapter.getOriginalResponse(),
            nativeCodexHistory,
          }),
      });
      appaHook.markContinuationResponseReady();
    } catch (error) {
      throw toAppaHookApiError(error);
    }
  }

  // Tool calls allowed (or no tool calls) - return response.
  // `usage` (corrected for zero-input above) is reused here.
  //
  // Computed once: a translator adapter that rewrites remembers the inner
  // (logged) shape it produced, so `getLoggedResponse` below must observe the
  // same call that produced the client response.
  // Note: Token metrics are reported by getObservableFetch() in the HTTP layer
  // for non-streaming requests. We only report cost here to avoid double counting.
  // TODO: Add test for metrics reported by the LLM proxy. It's not obvious since
  // mocked API clients can't use an observable fetch.
  // metrics.llm.reportLLMTokens(
  //   providerName,
  //   agent,
  //   { input: usage.inputTokens, output: usage.outputTokens },
  //   actualModel,
  //   source,
  // );

  const costs = await calculateInteractionCosts({
    actualModel,
    usage,
    providerName,
  });

  withSessionContext(sessionId, () => {
    metrics.llm.reportLLMCost({
      provider: providerName,
      profile: agent,
      model: actualModel,
      cost: costs.actualCost,
      source,
      billingMode,
      authMethod,
    });
    metrics.llm.reportLLMCacheCost(
      providerName,
      agent,
      actualModel,
      { cacheCost: costs.cacheCost, cacheReadSavings: costs.cacheReadSavings },
      source,
    );
  });

  try {
    const record = buildInteractionRecord({
      agent,
      externalAgentId,
      authMethod,
      billingMode,
      authenticatedApp,
      runId,
      userId,
      virtualKeyId,
      passthroughVirtualKeyId,
      appId,
      sessionId,
      sessionSource,
      source,
      providerType: provider.interactionType,
      request: originalRequest,
      processedRequest: request,
      // Bedrock<->OpenAI compat need to return OpenAI response to client, but store bedrock response for interaction log.
      // Providers which need this behavior should implement getLoggedResponse() for persisting interaction and getOriginalResponse() for returning to client.
      //
      // A repaired batch logs what the client actually received. `getLoggedResponse`
      // still wins where it exists: those adapters log a different wire shape on
      // purpose, and after a rewrite they hand back that shape's rewritten form.
      response: responseAdapter.getLoggedResponse?.() ?? clientResponse,
      actualModel,
      usage,
      costs,
      toonStats,
      toonSkipReason,
      dualLlmAnalyses,
      unsafeContextBoundary,
    });
    await persistProxyInteraction(
      record,
      lockedChat,
      delegationBillingEnvironmentId,
    );
  } catch (interactionError) {
    logger.error(
      { err: interactionError, profileId: agent.id },
      "Failed to create interaction record (agent may have been deleted)",
    );
  }

  try {
    const sent = reply.send(clientResponse);
    return sent;
  } catch (error) {
    await appaHook?.quarantineUndeliveredCalls();
    throw error;
  }
}

function appaHookPolicyBlock(
  toolCalls: AppaOutboundToolCall[],
): utils.toolInvocation.PolicyBlockResult {
  const blockedToolName = toolCalls[0]?.targetName || "unknown";
  const message = `${archestraMcpBranding.appName} LLM Proxy blocked unsafe tool call to ${blockedToolName}: OpenAPPA remote hook denied the call.`;
  return {
    refusalMessage: message,
    contentMessage: message,
    reason: "OpenAPPA remote hook denied the tool call",
    blockedToolName,
    toolInput: {},
    allToolCallNames: toolCalls.map((toolCall) => toolCall.targetName),
  };
}

function appaUnsupportedToolCallBlock(): utils.toolInvocation.PolicyBlockResult {
  const message = `${archestraMcpBranding.appName} LLM Proxy blocked an unsupported tool call while OpenAPPA hooks are enabled.`;
  return {
    refusalMessage: message,
    contentMessage: message,
    reason: "OpenAPPA hook does not support the provider tool-call shape",
    blockedToolName: "unsupported",
    toolInput: {},
    allToolCallNames: [],
  };
}

function normalizeToolCallsForAppa(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  canonicalizeToolName: utils.gatewayToolNames.ToolNameCanonicalizer,
  declaredMcpToolTargets: ReadonlyMap<string, string>,
): AppaOutboundToolCall[] {
  return toolCalls.map((toolCall) => {
    const [normalized] = normalizeToolCallsForPolicy(
      [toolCall],
      canonicalizeToolName,
    );
    if (!normalized) {
      throw new ApiError(
        400,
        "OpenAPPA proxy hooks could not normalize a tool call.",
      );
    }
    const nativeGatewayTool =
      canonicalizeToolName.isDeclaredNativeGatewayTool?.(toolCall.name) ??
      false;
    const trustedGatewayTarget =
      toolCall.name.startsWith("mcp__") || nativeGatewayTool
        ? canonicalizeToolName.resolveTrustedGatewayToolTarget?.({
            emittedName: toolCall.name,
            targetName: normalized.toolCallName,
          })
        : undefined;
    if (
      (toolCall.name.startsWith("mcp__") &&
        (!declaredMcpToolTargets.has(toolCall.name) ||
          !trustedGatewayTarget)) ||
      (nativeGatewayTool && !trustedGatewayTarget)
    ) {
      logger.error(
        {
          emittedName: toolCall.name,
          hasDeclaredTarget: declaredMcpToolTargets.has(toolCall.name),
          hasTrustedGatewayTarget: Boolean(trustedGatewayTarget),
          isNativeGatewayTool: nativeGatewayTool,
        },
        "Rejected untrusted MCP tool call",
      );
      throw new AppaProxySessionProtocolError(
        "MCP tool call is not a declared target of a registered gateway profile",
      );
    }
    return {
      id: toolCall.id,
      emittedName: toolCall.name,
      emittedArguments: toolCall.arguments,
      emittedArgumentsCanonical: canonicalJsonObject(toolCall.arguments),
      targetName:
        trustedGatewayTarget ??
        (normalized.toolCallName === toolCall.name
          ? (declaredMcpToolTargets.get(toolCall.name) ??
            normalized.toolCallName)
          : normalized.toolCallName),
      targetArguments: JSON.parse(normalized.toolCallArgs) as Record<
        string,
        unknown
      >,
      spawn: isAppaSpawnTool(normalized.toolCallName),
    };
  });
}

function isAppaSpawnTool(toolName: string): boolean {
  return /(^|__|\.)(spawn_agent|Agent|Task|task)$/.test(toolName);
}

const CLAUDE_NATIVE_CHILD_CONTRACT = "agent/claude-code/Agent";

function nativeSpawnCarrierPreparation(params: {
  session: AppaProxyHookSession;
  profileId: string;
  client: AppaNativeClient;
}):
  | {
      prepareSpawn: (
        call: AppaOutboundToolCall,
      ) => Promise<AppaOutboundToolCall>;
    }
  | undefined {
  if (params.client !== "claude-code" && params.client !== "opencode-kimi") {
    return undefined;
  }
  const ledger = new AppaProxyLedger({
    ...params.session.getNativeWireScope(),
    profileId: params.profileId,
  });
  return {
    prepareSpawn: async (call) => {
      let originalArguments: Record<string, unknown>;
      try {
        originalArguments = JSON.parse(call.emittedArguments) as Record<
          string,
          unknown
        >;
      } catch {
        throw new AppaProxySessionProtocolError(
          "Native spawn arguments must be a JSON object.",
        );
      }
      if (
        !originalArguments ||
        Array.isArray(originalArguments) ||
        typeof originalArguments.prompt !== "string"
      ) {
        throw new AppaProxySessionProtocolError(
          "Native spawn requires a documented prompt argument.",
        );
      }
      const prepared = await ledger.prepareChildCarrier({
        callId: call.id,
        originalArguments,
      });
      return {
        ...call,
        emittedArguments: JSON.stringify(prepared.rewrittenArguments),
        emittedArgumentsCanonical: prepared.rewrittenArgumentsCanonical,
        // OpenAPPA checks declared child contracts before it evaluates
        // arguments. Only the server-signed Claude carrier may name this
        // contract, so a client-authored Agent call cannot widen delegation.
        targetName:
          call.targetName === "Agent"
            ? CLAUDE_NATIVE_CHILD_CONTRACT
            : call.targetName,
        targetArguments: prepared.rewrittenArguments,
      };
    },
  };
}

/**
 * Called after APPA releases a normal native batch and before its frame is
 * issued. The runtime capability authorizes child creation; this only binds
 * the client-visible stock task path to that already-approved call.
 */
async function publishNativeChildSpawnAliases(params: {
  session: AppaProxyHookSession;
  frameId: string;
  calls: AccumulatedToolCall[];
  clientParentTaskPath: string | null;
  logicalParentTaskPath: string | null;
}): Promise<AccumulatedToolCall[]> {
  const spawnCalls = params.calls
    .map((call, position) => ({ call, position }))
    .filter(({ call }) => isAppaSpawnTool(call.name));
  if (spawnCalls.length === 0) return params.calls;
  if (!params.clientParentTaskPath || !params.logicalParentTaskPath) {
    throw new AppaProxySessionProtocolError(
      "native spawn has no verified parent task path",
    );
  }
  const bindings = parseNativeSpawnBindings(params.session);
  const aliases = [];
  const replacements = new Map<string, string>();
  for (const { call, position } of spawnCalls) {
    const binding = bindings.get(call.id);
    if (!binding) {
      throw new AppaProxySessionProtocolError(
        "native spawn has no runtime-approved spawn binding",
      );
    }
    const originalProviderTaskName = nativeSpawnTaskName(call.arguments);
    if (!originalProviderTaskName) {
      throw new AppaProxySessionProtocolError(
        "native spawn has invalid task_name arguments",
      );
    }
    const wireTaskName = `${originalProviderTaskName}__proxy_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const publication = prepareNativeChildSpawnPublication({
      taskAlias: {
        logicalTaskPath: `${params.logicalParentTaskPath}/${originalProviderTaskName}`,
        clientTaskPath: `${params.clientParentTaskPath}/${wireTaskName}`,
        wireTaskName,
      },
      position,
      clientParentTaskPath: params.clientParentTaskPath,
      logicalParentTaskPath: params.logicalParentTaskPath,
      originalProviderTaskName,
      approvedCall: { callId: call.id, spawnBinding: binding },
    });
    aliases.push(publication.alias);
    replacements.set(call.id, publication.rewrittenTaskName);
  }
  await AppaProxyWireModel.addAliases({
    ...params.session.getNativeWireScope(),
    frameId: params.frameId,
    aliases,
  });
  return params.calls.map((call) => {
    const taskName = replacements.get(call.id);
    if (!taskName) return call;
    return {
      ...call,
      arguments: rewriteNativeSpawnTaskName({
        argumentsJson: call.arguments,
        taskName,
      }),
    };
  });
}

function parseNativeSpawnBindings(
  session: AppaProxyHookSession,
): Map<string, string> {
  const raw = session.getSpawnBindingsHeaderValue();
  if (!raw) return new Map();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppaProxySessionProtocolError(
      "native spawn bindings are invalid",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppaProxySessionProtocolError(
      "native spawn bindings are invalid",
    );
  }
  return new Map(
    Object.entries(value).flatMap(([callId, binding]) =>
      typeof binding === "string" && binding.length > 0
        ? [[callId, binding] as const]
        : [],
    ),
  );
}

function nativeSpawnTaskName(argumentsJson: string): string | null {
  try {
    const value = JSON.parse(argumentsJson);
    return value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.task_name === "string" &&
      value.task_name.length > 0
      ? value.task_name
      : null;
  } catch {
    return null;
  }
}

function rewriteNativeSpawnTaskName(params: {
  argumentsJson: string;
  taskName: string;
}): string {
  const value = JSON.parse(params.argumentsJson);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppaProxySessionProtocolError(
      "native spawn has invalid task_name arguments",
    );
  }
  return JSON.stringify({ ...value, task_name: params.taskName });
}

function hasUnsupportedOpaqueProxyContext(request: unknown): boolean {
  if (!request || typeof request !== "object") {
    return false;
  }
  const values = request as Record<string, unknown>;
  return (
    (values.previous_response_id !== undefined &&
      values.previous_response_id !== null) ||
    (values.conversation !== undefined && values.conversation !== null)
  );
}

function isAppaHookSupportedRequest(
  provider: { interactionType: string },
  request: unknown,
): boolean {
  if (
    provider.interactionType !== "openai:chatCompletions" &&
    provider.interactionType !== "openai:responses" &&
    provider.interactionType !== "kimi:chatCompletions" &&
    provider.interactionType !== "anthropic:messages"
  ) {
    return false;
  }
  if (!request || typeof request !== "object") {
    return false;
  }
  const tools = (request as Record<string, unknown>).tools;
  if (tools === undefined) {
    return true;
  }
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.every((tool) => {
    if (
      provider.interactionType === "openai:chatCompletions" ||
      provider.interactionType === "kimi:chatCompletions"
    ) {
      return isOrdinaryChatFunctionTool(tool);
    }
    if (provider.interactionType === "openai:responses") {
      return isOrdinaryResponsesFunctionTool(tool);
    }
    return isOrdinaryAnthropicClientTool(tool);
  });
}

/** Inspect only declared tool containers, never arbitrary request payloads. */
function hasProviderHostedMcpToolDefinition(request: unknown): boolean {
  if (!isJsonObject(request) || !Array.isArray(request.tools)) return false;
  return request.tools.some(containsProviderHostedMcpTool);
}

function containsProviderHostedMcpTool(tool: unknown): boolean {
  if (!isJsonObject(tool)) return false;
  if (tool.type === "mcp") return true;
  if (tool.type !== "namespace") return false;
  // A namespace is a declaration container, not arbitrary metadata. Malformed
  // members must fail closed rather than bypass the nested hosted-tool check.
  return (
    !Array.isArray(tool.tools) || tool.tools.some(containsProviderHostedMcpTool)
  );
}

function appaHistoryProtocol(
  interactionType: string,
): AppaHistoryProtocol | null {
  if (interactionType === "anthropic:messages") {
    return "anthropic-messages";
  }
  if (
    interactionType === "openai:chatCompletions" ||
    interactionType === "kimi:chatCompletions"
  ) {
    return "openai-chat-completions";
  }
  return interactionType === "openai:responses" ? "openai-responses" : null;
}

/** A new root may contain fresh user prompts, but not an unbound model turn. */
function hasCheckpointForkIntent(history: readonly unknown[]): boolean {
  return history.some(
    (item) =>
      !isJsonObject(item) ||
      (item.type !== "additional_tools" &&
        (item.type !== "message" || item.role !== "user")),
  );
}

function hasNativeCodexToolSearch(response: unknown): boolean {
  return (
    !!response &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    Array.isArray((response as { output?: unknown }).output) &&
    (response as { output: unknown[] }).output.some(isCodexToolSearchCall)
  );
}

function finalizeStreamClientResponse(params: {
  providerResponse: unknown;
  clientNativeToolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }> | null;
  rewrittenToolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }> | null;
}): unknown {
  const response = params.clientNativeToolCalls
    ? replaceNativeCodexCallItems(
        params.providerResponse,
        params.clientNativeToolCalls,
      )
    : params.rewrittenToolCalls
      ? replaceNativeCodexCallItems(
          params.providerResponse,
          params.rewrittenToolCalls,
        )
      : params.providerResponse;
  return rewriteNativeCodexResponseForClient(response);
}

async function persistAppaCompletedResponse(params: {
  session: AppaProxyHookSession;
  profileId: string;
  provider: string;
  protocol: AppaHistoryProtocol | null;
  model: string;
  request: unknown;
  /** Exact client-visible wire, including authorized dispatch rewrites. */
  clientResponse: unknown;
  /** Provider wire retained only for native provider-history replay. */
  providerResponse: unknown;
  nativeCodexHistory?: NativeCodexHistory;
}): Promise<void> {
  if (params.nativeCodexHistory) {
    await persistNativeCodexHistory({
      history: params.nativeCodexHistory,
      response: params.providerResponse,
    });
  }
  if (!params.protocol) {
    throw new AppaProxyHookError("unavailable", "turn_end");
  }
  await params.session.checkpointCompletedResponse({
    profileId: params.profileId,
    provider: params.provider,
    protocol: params.protocol,
    model: params.model,
    request: params.request,
    response: params.clientResponse,
  });
}

function isOrdinaryChatFunctionTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") {
    return false;
  }
  const value = tool as Record<string, unknown>;
  if (
    value.type !== "function" ||
    !value.function ||
    typeof value.function !== "object"
  ) {
    return false;
  }
  const functionTool = value.function as Record<string, unknown>;
  return (
    typeof functionTool.name === "string" &&
    functionTool.name.length > 0 &&
    isJsonObject(functionTool.parameters)
  );
}

function isOrdinaryResponsesFunctionTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") {
    return false;
  }
  const value = tool as Record<string, unknown>;
  return (
    value.type === "function" &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    isJsonObject(value.parameters)
  );
}

function isOrdinaryAnthropicClientTool(tool: unknown): boolean {
  if (!isJsonObject(tool) || typeof tool.name !== "string" || !tool.name) {
    return false;
  }
  // Claude Code's client-executed tools omit `type`; server tools have no
  // input_schema and are intentionally not APPA-dispatchable.
  return (
    (tool.type === undefined || tool.type === "custom") &&
    isJsonObject(tool.input_schema)
  );
}

function hasUnsupportedOpenAiStreamToolCall(
  chunk: unknown,
  interactionType: string,
): boolean {
  return (
    (interactionType === "openai:chatCompletions" ||
      interactionType === "openai:responses" ||
      interactionType === "kimi:chatCompletions") &&
    containsCustomToolCall(chunk)
  );
}

function hasUnsupportedOpenAiResponseToolCall(
  response: unknown,
  interactionType: string,
): boolean {
  if (interactionType === "anthropic:messages") {
    if (!isJsonObject(response) || !Array.isArray(response.content)) {
      return true;
    }
    return response.content.some(
      (block) =>
        isJsonObject(block) &&
        block.type === "tool_use" &&
        (typeof block.id !== "string" ||
          typeof block.name !== "string" ||
          !isJsonObject(block.input)),
    );
  }
  if (
    interactionType !== "openai:chatCompletions" &&
    interactionType !== "openai:responses" &&
    interactionType !== "kimi:chatCompletions"
  ) {
    return true;
  }
  if (!isJsonObject(response) || containsCustomToolCall(response)) {
    return true;
  }
  // Adapters can replace invalid JSON with {}. Check the original argument
  // bytes so APPA never authorizes that fallback while clients receive raw data.
  if (
    interactionType === "openai:chatCompletions" ||
    interactionType === "kimi:chatCompletions"
  ) {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    return choices.some((choice) => {
      const message = isJsonObject(choice) ? choice.message : undefined;
      const calls =
        isJsonObject(message) && Array.isArray(message.tool_calls)
          ? message.tool_calls
          : [];
      return calls.some((call) => {
        const args =
          isJsonObject(call) && isJsonObject(call.function)
            ? call.function.arguments
            : undefined;
        return typeof args !== "string" || !isJsonObjectString(args);
      });
    });
  }
  const output = Array.isArray(response.output) ? response.output : [];
  return output.some(
    (item) =>
      isJsonObject(item) &&
      item.type === "function_call" &&
      (typeof item.arguments !== "string" ||
        !isJsonObjectString(item.arguments)),
  );
}

function containsCustomToolCall(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsCustomToolCall);
  }
  const record = value as Record<string, unknown>;
  // `custom` is a tool declaration, including the tool list carried by a
  // client-executed tool-search protocol item. Only a custom *call* can be an
  // executable provider output requiring the invocation gate.
  if (record.type === "custom_tool_call") {
    return true;
  }
  return Object.values(record).some(containsCustomToolCall);
}

function hasUnsupportedFunctionToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): boolean {
  return toolCalls.some(
    (toolCall) =>
      !toolCall.id || !toolCall.name || !isJsonObjectString(toolCall.arguments),
  );
}

function isJsonObjectString(value: string): boolean {
  try {
    return isJsonObject(JSON.parse(value));
  } catch {
    return false;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidAppaSessionId(value: string | null): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function resolveAppaThreadContext(params: {
  headers: Record<string, string | string[] | undefined>;
  request: unknown;
  sessionId: string | null;
  sessionSource: SessionSource;
  nativeClient: AppaNativeClient;
}):
  | {
      threadId: string;
      parentThreadId?: string;
      spawnBinding?: string;
    }
  | { error: string }
  | null {
  const headerThreadId = singleHeader(params.headers["thread-id"]);
  if (params.nativeClient === "claude-code") {
    const metadataUserId =
      isJsonObject(params.request) && isJsonObject(params.request.metadata)
        ? params.request.metadata.user_id
        : undefined;
    const nativeSessionId =
      typeof metadataUserId === "string"
        ? utils.headers.sessionId.extractClaudeMetadataSessionId(metadataUserId)
        : null;
    if (!nativeSessionId) return null;
    const nativeHeaderSessionId = singleHeader(
      params.headers["x-claude-code-session-id"],
    );
    const alias =
      params.sessionSource === "claude_metadata" ? undefined : params.sessionId;
    if (
      (nativeHeaderSessionId !== undefined &&
        nativeHeaderSessionId !== nativeSessionId) ||
      (headerThreadId !== undefined && headerThreadId !== nativeSessionId) ||
      (alias !== undefined && alias !== nativeSessionId)
    ) {
      return {
        error:
          "OpenAPPA native Claude session metadata conflicts with a native or client session alias.",
      };
    }
    return { threadId: nativeSessionId };
  }
  const metadataSessionId =
    isJsonObject(params.request) && isJsonObject(params.request.client_metadata)
      ? params.request.client_metadata.session_id
      : undefined;
  const metadataRootTurnId =
    isJsonObject(params.request) && isJsonObject(params.request.client_metadata)
      ? params.request.client_metadata.root_turn_id
      : undefined;
  const metadataThreadId =
    isJsonObject(params.request) && isJsonObject(params.request.client_metadata)
      ? params.request.client_metadata.thread_id
      : undefined;
  const threadId =
    headerThreadId ??
    (typeof metadataRootTurnId === "string" ? metadataRootTurnId : undefined) ??
    (typeof metadataSessionId === "string" ? metadataSessionId : undefined) ??
    (typeof metadataThreadId === "string" ? metadataThreadId : undefined);
  const parentThreadId = singleHeader(
    params.headers["x-codex-parent-thread-id"],
  );
  const spawnBinding = singleHeader(
    params.headers["x-archestra-appa-spawn-binding"],
  );
  if (parentThreadId && !threadId) return null;
  if (threadId) {
    return parentThreadId
      ? { threadId, parentThreadId, spawnBinding }
      : { threadId };
  }
  // Native clients carry their stable trajectory id in protocol metadata.
  // `openai_user` is attribution, not a conversation identity.
  return params.sessionSource !== "openai_user" && params.sessionId
    ? { threadId: params.sessionId }
    : null;
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The adapter's normalized result list identifies output bodies. Call names and
 * arguments from caller history are only contradiction checks: the durable
 * ledger remains the source of authority for both values.
 */
function collectAppaInboundToolResults(params: {
  request: unknown;
  interactionType: string;
}): AppaInboundToolResult[] {
  const protocolResults = collectAppaProtocolToolResults(params);
  if (
    protocolResults.length > 0 ||
    params.interactionType === "anthropic:messages"
  ) {
    return protocolResults;
  }
  const claimedCalls = new Map<
    string,
    { name: string; rawArguments: string }
  >();
  if (isJsonObject(params.request)) {
    if (params.interactionType === "openai:chatCompletions") {
      const messages = Array.isArray(params.request.messages)
        ? params.request.messages
        : [];
      for (const message of messages) {
        if (!isJsonObject(message) || !Array.isArray(message.tool_calls))
          continue;
        for (const call of message.tool_calls) {
          if (!isJsonObject(call) || !isJsonObject(call.function)) continue;
          if (
            typeof call.id === "string" &&
            typeof call.function.name === "string" &&
            typeof call.function.arguments === "string"
          ) {
            claimedCalls.set(call.id, {
              name: call.function.name,
              rawArguments: call.function.arguments,
            });
          }
        }
      }
    } else if (params.interactionType === "openai:responses") {
      const input = Array.isArray(params.request.input)
        ? params.request.input
        : [];
      for (const item of input) {
        if (
          !isJsonObject(item) ||
          item.type !== "function_call" ||
          typeof item.call_id !== "string" ||
          typeof item.name !== "string" ||
          typeof item.arguments !== "string"
        ) {
          continue;
        }
        claimedCalls.set(item.call_id, {
          name: codexToolName({ name: item.name, namespace: item.namespace }),
          rawArguments: item.arguments,
        });
      }
    }
  }
  if (!isJsonObject(params.request)) return [];
  if (params.interactionType === "openai:chatCompletions") {
    const messages = Array.isArray(params.request.messages)
      ? params.request.messages
      : [];
    const results = messages.flatMap((message) => {
      if (
        !isJsonObject(message) ||
        message.role !== "tool" ||
        typeof message.tool_call_id !== "string"
      ) {
        return [];
      }
      return [
        {
          id: message.tool_call_id,
          // Keep the source representation. Trusted-data/TOON transformations
          // happen after this identity and APPA admission boundary.
          content: message.content,
          claimedCall: claimedCalls.get(message.tool_call_id),
        },
      ];
    });
    return results;
  }
  if (params.interactionType === "openai:responses") {
    const input = Array.isArray(params.request.input)
      ? params.request.input
      : [];
    const results = input.flatMap((item) => {
      if (
        !isJsonObject(item) ||
        item.type !== "function_call_output" ||
        typeof item.call_id !== "string"
      ) {
        return [];
      }
      return [
        {
          id: item.call_id,
          content: item.output,
          claimedCall: claimedCalls.get(item.call_id),
        },
      ];
    });
    return results;
  }
  return [];
}

function applyAppaOutcomeNotices<T>(
  body: T,
  updates: ReadonlyMap<string, string>,
): T {
  if (!isJsonObject(body)) return body;
  return {
    ...body,
    ...(Array.isArray(body.messages)
      ? {
          messages: body.messages.map((message) => {
            if (
              !isJsonObject(message) ||
              message.role !== "tool" ||
              typeof message.tool_call_id !== "string"
            )
              return message;
            const content = updates.get(message.tool_call_id);
            return content === undefined ? message : { ...message, content };
          }),
        }
      : {}),
    ...(Array.isArray(body.input)
      ? {
          input: body.input.map((item) => {
            if (
              !isJsonObject(item) ||
              item.type !== "function_call_output" ||
              typeof item.call_id !== "string"
            )
              return item;
            const output = updates.get(item.call_id);
            return output === undefined ? item : { ...item, output };
          }),
        }
      : {}),
  } as T;
}

function toAppaHookApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  // The client gets a stable fail-closed error, but the original boundary
  // failure must remain available in backend logs for native wire diagnosis.
  logger.error(
    { err: error, stage: "appa_hook_boundary" },
    "OpenAPPA hook boundary failed",
  );
  if (
    error instanceof Error &&
    [
      "AppaProxySessionProtocolError",
      "AppaProxySessionBusyError",
      "AppaProxySessionQuarantinedError",
    ].includes(error.name)
  ) {
    return new ApiError(
      409,
      `OpenAPPA conversation rejected: ${error.message}`,
    );
  }
  if (error instanceof AppaProxyHookError) {
    return new ApiError(
      error.kind === "unavailable" ? 503 : 403,
      error.kind === "unavailable"
        ? "OpenAPPA remote hook did not authorize the request."
        : "OpenAPPA remote hook denied the request.",
    );
  }
  return new ApiError(
    503,
    "OpenAPPA remote hook did not authorize the request.",
  );
}

/**
 * Plan the dispatch-mode repair for one turn's tool calls, and record it when
 * there is one. Shared by the streaming and non-streaming paths so the two
 * surfaces stay in step.
 *
 * `supported` is the adapter's ability to re-emit the rewritten calls in its
 * own wire format; without it the repair could never reach the client, so that
 * provider keeps the pre-existing refusal-with-steer behavior.
 */
function planDispatchRewrites(params: {
  supported: boolean;
  toolCalls: AccumulatedToolCall[];
  enabledToolNames: Set<string>;
  canonicalizeToolName: utils.gatewayToolNames.ToolNameCanonicalizer;
  providerName: string;
}): AccumulatedToolCall[] | null {
  if (!params.supported) {
    return null;
  }

  const rewritten = planDispatchModeToolCallRewrites({
    toolCalls: params.toolCalls,
    enabledToolNames: params.enabledToolNames,
    canonicalizeToolName: params.canonicalizeToolName,
  });

  if (rewritten) {
    logger.info(
      {
        toolNames: params.toolCalls.map((toolCall) => toolCall.name),
        provider: params.providerName,
      },
      "Re-addressing direct tool calls through run_tool (dispatch mode)",
    );
  }
  return rewritten;
}

function normalizeVirtualKeyCandidate(
  apiKey: string | undefined,
): string | undefined {
  if (!apiKey) {
    return undefined;
  }

  return apiKey.replace(/^Bearer[:\s]+/i, "");
}

/**
 * Turns a premature proxy-client disconnect into an AbortSignal that the
 * Microsoft Graph adapter forwards to conversation and chat requests. Normal
 * response closure does not abort, and listeners remove each other on either
 * terminal path.
 */
function createDownstreamAbortSignal(params: {
  request: FastifyRequest;
  reply: FastifyReply;
}): AbortSignal {
  const { request, reply } = params;
  const controller = new AbortController();

  const cleanup = () => {
    request.raw.removeListener("aborted", onRequestAborted);
    reply.raw.removeListener("close", onReplyClosed);
  };
  const onRequestAborted = () => {
    cleanup();
    controller.abort();
  };
  const onReplyClosed = () => {
    cleanup();
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  };

  if (request.raw.aborted || reply.raw.destroyed) {
    controller.abort();
  } else {
    request.raw.once("aborted", onRequestAborted);
    reply.raw.once("close", onReplyClosed);
  }

  return controller.signal;
}

/**
 * Whether the backend authenticates upstream with its OWN credentials for this
 * provider and discards whatever the caller sent.
 *
 * Gemini in Vertex AI mode builds its client from the server's project and
 * ADC/service-account credentials, never reading the caller's key — so a
 * caller-supplied Authorization value is not a credential and cannot stand in
 * for authentication.
 *
 * Azure (Entra ID) and Anthropic workload identity are deliberately absent:
 * both fall back to server credentials only when no caller key is present. In
 * Anthropic Vertex AI mode, the configured Google credential always replaces
 * caller credentials, matching Gemini's Vertex behavior.
 */
function providerSuppliesServerCredential(providerName: string): boolean {
  return (
    (providerName === "gemini" && isVertexAiEnabled()) ||
    (providerName === "anthropic" && anthropicVertexClient.isEnabled())
  );
}

function shouldUseKeylessProviderApiKey(params: {
  row: Awaited<ReturnType<typeof LlmProviderApiKeyModel.findById>>;
  providerName: string;
}): boolean {
  const { row, providerName } = params;
  if (!row) {
    return false;
  }

  if (row.provider !== providerName) {
    logger.warn(
      {
        providerApiKeyId: row.id,
        providerApiKeyProvider: row.provider,
        requestedProvider: providerName,
      },
      "Loopback provider API key provider mismatch",
    );
    return false;
  }

  if (row.secretId) {
    return false;
  }

  return isProviderApiKeyOptional({
    provider: row.provider,
    azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
    anthropicKeylessAuthEnabled: isAnthropicKeylessAuthEnabled(),
  });
}

function headerNamePeek(
  headers: Record<string, string> | null | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const [k, v] of Object.entries(headers)) {
    result[k] = typeof v === "string" && v.length > 0 ? v[0] : "";
  }
  return result;
}

/**
 * Derive a status_code label for the request-duration metric from a thrown
 * provider error. Bedrock's client attaches `statusCode` to its errors; when
 * absent (network failure before a response) we fall back to "0", matching how
 * getObservableFetch labels network errors.
 */
function extractDurationStatusCode(error: unknown): string {
  const statusCode = (error as { statusCode?: number } | null)?.statusCode;
  return typeof statusCode === "number" ? String(statusCode) : "0";
}

/**
 * The single funnel every proxy interaction write goes through, so all five
 * sites treat locked-chat identically.
 *
 * - `encrypt`: store the full record, keyed to the conversation's browser-held
 *   DEK (recoverable offline via that conversation's escrow record).
 * - `redact`: fail-closed — content is replaced with the redaction marker
 *   rather than risking a plaintext write or an unrecoverable one.
 * - `none`: ordinary write; at-rest rules apply.
 */
async function persistProxyInteraction(
  record: InsertInteraction,
  lockedChat: LockedChatAuditDisposition,
  environmentIdOverride?: string,
): Promise<void> {
  await InteractionModel.create(
    lockedChat.kind === "redact" ? redactLockedChatInteraction(record) : record,
    lockedChat.kind === "encrypt" ? lockedChat.audit : null,
    environmentIdOverride ? { environmentIdOverride } : undefined,
  );
}

/**
 * Resolve the environment an advisor consultation bills to, from
 * DELEGATION_BILLING_ENVIRONMENT_HEADER. Honored only when all three hold:
 * the request arrived over the loopback socket (the in-process A2A executor's
 * path — the raw socket peer, not request.ip, which trustProxy can rewrite
 * from forwarded headers), the executing agent row is the advisor built-in,
 * and the id names an environment of that agent's organization. Anything else
 * ignores the header with a warning: the worst a spoofed value can do is
 * misattribute advisor spend between one organization's environments.
 */
async function resolveDelegationBillingEnvironment(
  request: FastifyRequest,
  agent: GatewayAgent,
): Promise<string | undefined> {
  const raw =
    request.headers[DELEGATION_BILLING_ENVIRONMENT_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return undefined;
  }

  if (!isLoopbackRequest(request)) {
    logger.warn(
      { agentId: agent.id },
      "Ignoring delegation billing environment header from a non-loopback peer",
    );
    return undefined;
  }
  if (agent.builtInAgentConfig?.name !== BUILT_IN_AGENT_IDS.ADVISOR) {
    logger.warn(
      { agentId: agent.id },
      "Ignoring delegation billing environment header on a non-advisor agent",
    );
    return undefined;
  }
  // The env-id column is a uuid; a non-uuid value would make the lookup's cast
  // throw and 500 the LLM call (leaking the query), so reject it here — an
  // unusable header must be ignored, not fatal.
  if (!isUuid(value)) {
    logger.warn(
      { agentId: agent.id },
      "Ignoring malformed delegation billing environment header",
    );
    return undefined;
  }
  // A lookup failure must not fail the LLM call — the header only refines
  // billing attribution, so on any error fall back to the agent's own env.
  let environment: Awaited<
    ReturnType<typeof EnvironmentModel.findByIdForOrganization>
  >;
  try {
    environment = await EnvironmentModel.findByIdForOrganization(
      value,
      agent.organizationId,
    );
  } catch (error) {
    logger.warn(
      { err: error, agentId: agent.id },
      "Ignoring delegation billing environment header after a lookup error",
    );
    return undefined;
  }
  if (!environment) {
    logger.warn(
      { agentId: agent.id, environmentId: value },
      "Ignoring delegation billing environment header naming an unknown environment",
    );
    return undefined;
  }
  return environment.id;
}

/**
 * Resolve the MCP App an app-runtime completion is attributed to, from
 * APP_ID_HEADER. Honored only when all three hold: the request arrived over the
 * loopback socket (the in-process app-runtime tool's path — the raw socket peer,
 * not request.ip, which trustProxy can rewrite from forwarded headers), the id
 * is a uuid, and it names an app of the executing agent's organization.
 * Anything else ignores the header with a warning: the worst a spoofed value
 * can do is misattribute app spend between one organization's apps, so an
 * unusable header must be ignored rather than fail the LLM call.
 */
async function resolveAttributedAppId(
  request: FastifyRequest,
  agent: GatewayAgent,
): Promise<string | undefined> {
  const raw = request.headers[APP_ID_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return undefined;
  }

  if (!isLoopbackRequest(request)) {
    logger.warn(
      { agentId: agent.id },
      "Ignoring app attribution header from a non-loopback peer",
    );
    return undefined;
  }
  // The app-id column is a uuid; a non-uuid value would make the lookup's cast
  // throw and 500 the LLM call, so reject it here.
  if (!isUuid(value)) {
    logger.warn(
      { agentId: agent.id },
      "Ignoring malformed app attribution header",
    );
    return undefined;
  }
  let app: Awaited<ReturnType<typeof AppModel.findById>>;
  try {
    app = await AppModel.findById(value);
  } catch (error) {
    logger.warn(
      { err: error, agentId: agent.id },
      "Ignoring app attribution header after a lookup error",
    );
    return undefined;
  }
  if (!app || app.organizationId !== agent.organizationId) {
    logger.warn(
      { agentId: agent.id, appId: value },
      "Ignoring app attribution header naming an app outside the agent's organization",
    );
    return undefined;
  }
  return app.id;
}

function exposeAppaSpawnBindings(params: {
  reply: FastifyReply;
  appaHook: AppaProxyHookSession;
}): void {
  const value = params.appaHook.getSpawnBindingsHeaderValue();
  if (!value) return;
  params.reply.header(APPA_SPAWN_BINDINGS_HEADER, value);
}

async function persistHeldNativeHistory(params: {
  session: AppaProxyHookSession;
  history: NativeCodexHistory | undefined;
  response: unknown;
}): Promise<void> {
  try {
    if (!params.history)
      throw new AppaProxyHookError("unavailable", "outbound");
    await persistNativeCodexHistory({
      history: params.history,
      response: params.response,
    });
  } catch (error) {
    await params.session.quarantineHeldResponse();
    throw error;
  }
}

async function persistPendingNativeCodexHistory(params: {
  history: NativeCodexHistory | undefined;
  response: unknown;
}): Promise<void> {
  if (!params.history) {
    throw new AppaProxyHookError("unavailable", "outbound");
  }
  await persistNativeCodexHistory({
    history: params.history,
    response: params.response,
  });
}

async function restoreHeldNativeResponse(params: {
  session: AppaProxyHookSession;
  heldFrameId: string;
  calls: AppaOutboundToolCall[] | [AppaSyntheticControlCall];
  omitPublishedContext?: boolean;
}): Promise<Record<string, unknown>> {
  const held = await AppaProxyWireModel.findOwned({
    ...params.session.getNativeWireScope(),
    frameId: params.heldFrameId,
  });
  if (
    !held ||
    !isPlainObject(held.payload) ||
    !isPlainObject(held.payload.response)
  ) {
    throw new AppaProxySessionProtocolError(
      "held native response is unavailable",
    );
  }
  const response = params.omitPublishedContext
    ? {
        ...held.payload.response,
        output: Array.isArray(held.payload.response.output)
          ? held.payload.response.output.filter(
              (item) => isPlainObject(item) && item.type === "function_call",
            )
          : [],
      }
    : held.payload.response;
  const calls = params.calls;
  if (isSyntheticControl(calls[0])) {
    return replaceHeldCallsWithControl(response, calls[0]);
  }
  const businessCalls = calls as AppaOutboundToolCall[];
  const clientCallArguments = await restoreNativeCodexClientProcessCalls({
    scope: params.session.getNativeWireScope(),
    calls: businessCalls.map((call) => ({
      name: call.emittedName,
      arguments: call.emittedArguments,
    })),
  });
  const clientCalls = businessCalls.map((call, index) => ({
    ...call,
    emittedArguments: clientCallArguments[index].arguments,
  }));
  return rewriteNativeCodexResponseForClient(
    replaceNativeCodexCallItems(
      response,
      clientCalls.map((call) => ({
        id: call.id,
        name: call.emittedName,
        arguments: call.emittedArguments,
      })),
    ),
  ) as Record<string, unknown>;
}

function nativeCodexFunctionCallItemIds(request: unknown): Map<string, string> {
  const itemIds = new Map<string, string>();
  const duplicateCallIds = new Set<string>();
  if (!isPlainObject(request) || !Array.isArray(request.input)) return itemIds;
  for (const item of request.input) {
    if (
      !isPlainObject(item) ||
      item.type !== "function_call" ||
      typeof item.call_id !== "string" ||
      typeof item.id !== "string" ||
      duplicateCallIds.has(item.call_id)
    ) {
      continue;
    }
    if (itemIds.has(item.call_id)) {
      itemIds.delete(item.call_id);
      duplicateCallIds.add(item.call_id);
      continue;
    }
    itemIds.set(item.call_id, item.id);
  }
  return itemIds;
}

function replaceHeldCallsWithControl(
  response: Record<string, unknown>,
  control: AppaSyntheticControlCall,
): Record<string, unknown> {
  const output = Array.isArray(response.output) ? response.output : [];
  const controlItem = {
    id: `fc_${control.id}`,
    type: "function_call",
    call_id: control.id,
    namespace: control.namespace,
    name: control.name,
    arguments: control.arguments,
  };
  return rewriteNativeCodexResponseForClient({
    ...response,
    id: `resp_${control.id}`,
    output: [
      ...output.filter(
        (item) => !isPlainObject(item) || item.type !== "function_call",
      ),
      controlItem,
    ],
  });
}

function isSyntheticControl(
  call: AppaOutboundToolCall | AppaSyntheticControlCall | undefined,
): call is AppaSyntheticControlCall {
  return Boolean(call && "namespace" in call);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read the locked chat key off the request. A malformed header is
 * treated as absent (the resolver then fails closed to redaction) rather than
 * failing the LLM call — the proxy's job is to serve the request; losing the
 * key costs audit fidelity, not the user's turn.
 */
function readLockedChatDek(request: FastifyRequest): Buffer | null {
  const raw = request.headers[LOCKED_CHAT_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  try {
    return parseLockedChatDekHeader(value);
  } catch {
    return null;
  }
}
