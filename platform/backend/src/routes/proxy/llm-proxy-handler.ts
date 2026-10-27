import { enterOpenappaEncryptedChat } from "@/openappa/encrypted-chat";
import { validateAzureModelOperation } from "@/services/azure-model-capabilities";
import type {
  BillingAttribution,
  PricedBillingUsage,
} from "@/utils/billable-usage";
import { primaryBillingUsage } from "@/utils/billable-usage";
import { ObservedProviderUsageError } from "@/utils/observed-provider-usage-error";
/**
 * Generic LLM Proxy Handler
 *
 * A reusable handler that works with any LLM provider through the adapter pattern.
 * Routes choose which adapter factory to use based on URL.
 */

import {
  APP_ID_HEADER,
  ArchestraInternalErrorCode,
  type BillingMode,
  CHAT_API_KEY_ID_HEADER,
  hasArchestraTokenPrefix,
  type InteractionSource,
  InteractionSourceSchema,
  isCodexOriginator,
  isProviderApiKeyOptional,
  OPENCODE_AGENT_HEADER,
  openCodeFamilySource,
  PROVIDER_BASE_URL_HEADER,
  providerDisplayNames,
  providerRequiresPerUserCredential,
  SOURCE_HEADER,
  stripClaudeContextVariantSuffix,
} from "@archestra/shared";
import {
  ARCHESTRA_CODEX_CONNECTION_ORIGINATOR,
  CLAUDE_DESKTOP_CLIENT_ID,
} from "@archestra/shared/interactions/client";
import { isOpenCodeFamilyClient } from "@archestra/shared/opencode-family";
import {
  type Context,
  context as otelContext,
  propagation,
} from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isAnthropicKeylessAuthEnabled } from "@/clients/anthropic-keyless-auth";
import { anthropicVertexClient } from "@/clients/anthropic-vertex";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { internalCallProvenance } from "@/clients/internal-call";
import { modelsDevClient } from "@/clients/models-dev-client";
import config from "@/config";
import {
  ENCRYPTED_CHAT_KEY_HEADER,
  parseEncryptedChatDekHeader,
} from "@/content-encryption/encrypted-chat";
import { enterpriseTier } from "@/enterprise-tier";
import { resolveLogContentMode } from "@/log-content";
import logger from "@/logging";
import {
  AppModel,
  InteractionModel,
  LimitValidationService,
  LlmProviderApiKeyModel,
  ModelModel,
  OrganizationModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import ProxyRequestContextModel, {
  type ProxyRequestState,
} from "@/models/proxy-request-context";
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
import { stripChildTrajectoryReceipts } from "@/openappa/child-trajectory-receipt";
import { sanitizeProviderBoundRequest } from "@/openappa/request";
import { isAppaChatSource } from "@/openappa/service";
import type { GovernedThread } from "@/openappa/thread-state";
import { restoreTrajectoryStampText } from "@/openappa/trajectory-stamp";
import { startedUnenforced } from "@/openappa/unenforced";
import { appaWireFamily } from "@/openappa/wire";
import {
  admitOpenappaRequest,
  type OpenappaAdmission,
  resolveInstallerSetupBypass,
} from "@/proxy/plugins/appa-plugin-archestra/host/admission";
import { BufferedChildStream } from "@/proxy/plugins/appa-plugin-archestra/host/child-stream-buffer";
import { prepareOpenappaRequest } from "@/proxy/plugins/appa-plugin-archestra/host/governed-request";
import {
  followAppaSessionHeader,
  scrubOpenappaIngress,
} from "@/proxy/plugins/appa-plugin-archestra/host/ingress";
import { OpenappaReceipts } from "@/proxy/plugins/appa-plugin-archestra/host/receipts";
import {
  getLlmProxyPluginRegistry,
  type LlmProxyPluginRegistry,
  type LlmProxyRequestContext,
  type LlmProxyToolCallRefusal,
} from "@/proxy/plugins/registry";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { llmProxyTiming } from "@/server/llm-proxy-timing";
import { configCache } from "@/services/config-cache";
import { enrichDiscoveredModel } from "@/services/discovered-model-enrichment";
import { getGuardrailsDeploymentFromSnapshot } from "@/services/guardrails-deployment";
import { LlmThroughput, ThroughputError } from "@/services/llm-throughput";
import { resolveRequestAttributionLabels } from "@/services/request-attribution-labels";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import {
  ApiError,
  type GatewayAgent,
  type HostedToolCall,
  type InsertInteraction,
  type InteractionAuthMethod,
  type InteractionRequest,
  type InteractionResponse,
  type LLMProvider,
  type LLMStreamAdapter,
  type OpenAiCodexPassthrough,
  type StreamErrorFrameContext,
  type ToolCallBlock,
} from "@/types";
import type { AttributionLabels } from "@/types/attribution-label";
import { asRecord } from "@/utils/as-record";
import { clientDisconnectSignal } from "@/utils/client-disconnect-signal";
import { repairLoneSurrogates } from "@/utils/lone-surrogates";
import { withMediaUsageAvailability } from "@/utils/media-usage";
import { isUuid } from "@/utils/uuid";
import { CodexResponsesGenerationError } from "./adapters/openai-codex-translator";
import {
  discardUnadmittedResponsesOutput,
  ResponsesStreamIncompleteError,
  withoutResponsesModelOutput,
  withoutResponsesModelOutputSSE,
} from "./adapters/openai-responses";
import {
  assertConsistentUserCredentials,
  assertPlatformAuthenticated,
  attemptJwksAuth,
  isJwtLike,
  readPassthroughAuthenticationSnapshot,
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
  calculateUsageCost,
  estimateCutOffAttemptUsage,
  handleError,
  isRetryableUpstreamConnectionFailure,
  planDispatchModeToolCallRewrites,
  recordBlockedToolCallMetrics,
  reportBillableUsageMetrics,
  shouldForwardAnthropicBeta,
  toSpanUserInfo,
  toToolCallBlock,
  upstreamErrorMessage,
  withProviderToolCallIds,
  withSessionContext,
} from "./llm-proxy-helpers";
import {
  MODEL_POOL_FIRST_CHUNK_TIMEOUT_MS,
  MODEL_POOL_MAX_RESPONSE_TIMEOUT_MS,
  MODEL_POOL_MS_PER_OUTPUT_TOKEN,
  MODEL_POOL_RESPONSE_TIMEOUT_MS,
  type ModelPoolPlan,
  openThroughModelPool,
  type PlannedMember,
  planModelPool,
  type UpstreamAttempt,
} from "./model-pool-failover";
import {
  inboundPoolWire,
  type MemberTransport,
  memberAdapter,
  memberTransport,
  requestedMaxOutputTokens,
} from "./model-pool-transport";
import { StreamKeepAlive } from "./stream-keepalive";
import {
  openUpstreamWithRetry,
  withFirstChunk,
} from "./upstream-connection-retry";
import * as utils from "./utils";
import { getAzureProxyIngress } from "./utils/azure-ingress";
import { withClaudeDesktopSubscriptionPreamble } from "./utils/claude-desktop-subscription";
import { resolveClientGatewayBindings } from "./utils/client-gateway-bindings";
import { consumeClientRuntimeEvidence } from "./utils/client-runtime-evidence";
import {
  type EncryptedChatAuditDisposition,
  redactEncryptedChatInteraction,
  resolveEncryptedChatAuditContext,
} from "./utils/encrypted-chat-session";
import type { SessionSource } from "./utils/headers/session-id";

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
  attributionLabels?: AttributionLabels;
  throughput?: LlmThroughput;
  usageAccountingMode?: PricedBillingUsage["mode"];
  providerApiKeyId?: string;
  /**
   * The upstream attempt this request's interaction rows record: which
   * provider key served it and, through a model pool, which attempt it was.
   * Mutated as a pool moves between members.
   */
  upstreamAttempt: UpstreamAttempt;
  /** Set when the request's model is a model pool's name. */
  modelPool?: ModelPoolRouting;
  billingAttribution?: BillingAttribution;
  connectionVerification?: boolean;
  appaReceipts?: OpenappaReceipts;
  governedThread?: GovernedThread;
  pluginRegistry?: LlmProxyPluginRegistry;
  pluginContext?: LlmProxyRequestContext;
  agent: GatewayAgent;
  originalRequest: TRequest;
  actualModel: string;
  enabledToolNames: Set<string>;
  /** Which tool each client-presented name is, and whether the gateway attested it. */
  toolIdentity: utils.gatewayToolNames.GatewayToolIdentity;
  /**
   * Encrypted chat session: span content capture is suppressed and persisted
   * content is either encrypted or redacted (usage/cost metadata untouched).
   * True whenever `encrypted-chat.kind !== "none"`.
   */
  suppressContent: boolean;
  /**
   * How this request's persisted audit content must be keyed. `encrypt`
   * carries the validated conversation key; `redact` is the fail-closed
   * fallback. Resolved once per request so every write site agrees.
   */
  encryptedChat: EncryptedChatAuditDisposition;
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
  /** Team the authenticating credential's spend is charged to. */
  billingTeamId?: string;
  userId?: string;
  serviceAccountId?: string;
  resolvedUser?: { id: string; email: string; name: string } | null;
  virtualKeyId?: string;
  passthroughVirtualKeyId?: string;
  sessionId?: string | null;
  sessionSource?: SessionSource;
  source: InteractionSource;
  runId?: string;
  parentContext?: Context;
  teams?: SpanTeamInfo[];
  userTeams?: SpanTeamInfo[];
  /**
   * Client-visible latency clock. `requestReceivedAt` is stamped on entry to
   * the handler; `firstByteAt` is set by `ensureStreamHeaders` the moment the
   * response is committed — which, on a lazily committed stream, is also the
   * first byte the client sees, wherever in preflight or streaming it happens.
   */
  streamTiming: StreamTiming;
}

/** How a request is spread across its model pool's members. */
export interface ModelPoolRouting {
  plan: ModelPoolPlan;
  transportFor: (
    member: PlannedMember,
    signal: AbortSignal,
  ) => Promise<MemberTransport>;
  recordFailedAttempt: (attempt: UpstreamAttempt) => Promise<void>;
  setResponseHeaders: (attempt: UpstreamAttempt) => void;
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
  /** A model pool the Model Router already let this caller use. */
  modelPoolId?: string;
  authenticatedApp?: {
    id: string;
    name: string;
    clientId: string;
  };
  userId?: string;
  serviceAccountId?: string;
  /** Team the authenticating credential's spend is charged to. */
  billingTeamId?: string;
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

function resolveOpenAiCodexPassthrough(params: {
  provider: Pick<
    LLMProvider<unknown, unknown, unknown, unknown, unknown>,
    "provider" | "interactionType"
  >;
  headers: Record<string, string | string[] | undefined>;
}): OpenAiCodexPassthrough | undefined {
  const { provider, headers } = params;
  const accountId = readSingleHeader(headers, "chatgpt-account-id");
  const originator = readSingleHeader(headers, "originator");
  const authorization = readSingleHeader(headers, "authorization");
  const accessToken = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (
    provider.provider === "openai" &&
    provider.interactionType === "openai:responses" &&
    isCodexOriginator(originator) &&
    accessToken &&
    isJwtLike(accessToken) &&
    accountId === undefined
  ) {
    throw new ApiError(400, "Codex ChatGPT login requires an account ID.");
  }
  if (
    provider.provider !== "openai" ||
    provider.interactionType !== "openai:responses" ||
    (readSingleHeader(headers, "x-archestra-opencode-oauth-bridge") !==
      "true" &&
      !(
        isCodexOriginator(originator) &&
        accountId !== undefined &&
        accessToken &&
        isJwtLike(accessToken)
      ))
  ) {
    return undefined;
  }

  if (
    !accessToken ||
    accessToken.length > 16_384 ||
    hasArchestraTokenPrefix(accessToken) ||
    !isBoundedHeaderValue(accountId, 256)
  ) {
    throw new ApiError(
      400,
      "Codex subscription requests require a bearer token and ChatGPT account ID.",
    );
  }

  return {
    accessToken,
    accountId,
    residency: optionalBoundedHeader(
      headers,
      "x-openai-internal-codex-residency",
      64,
    ),
    originator: optionalBoundedHeader(headers, "originator", 128),
    version: optionalBoundedHeader(headers, "version", 32),
    sessionId: optionalBoundedHeader(headers, "session-id", 256),
    userAgent: optionalBoundedHeader(headers, "user-agent", 1024),
  };
}

function optionalBoundedHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
  maxLength: number,
): string | undefined {
  const value = readSingleHeader(headers, name);
  if (value === undefined) return undefined;
  if (!isBoundedHeaderValue(value, maxLength)) {
    throw new ApiError(400, `Invalid Codex subscription ${name} header.`);
  }
  return value;
}

function readSingleHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function isBoundedHeaderValue(
  value: string | undefined,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\r\n]/.test(value)
  );
}

/**
 * The subset of a proxied request body we read for session-id and client-app
 * extraction. Each consumer only touches its own fields (`detectClaudeClientId`
 * → `system`/`metadata`; `detectCodexClientId` → `client_metadata`;
 * `detectOpenCodeClientId` → client identity headers;
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
): Promise<FastifyReply> {
  const streamTiming: StreamTiming = { requestReceivedAt: Date.now() };
  const clientRuntimeEvidence = consumeClientRuntimeEvidence(request);
  const proof = internalCallProvenance(request);
  // Credential paths accept either proof; only the guardrail proof reaches
  // OpenAPPA as its bypass.
  const internalCall = proof.inProcess || proof.guardrail;
  const headers = request.headers as unknown as THeaders;
  const agentId = (request.params as { agentId?: string }).agentId;
  const providerName = provider.provider;
  const connectionVerification =
    appaWireFamily(provider.interactionType) === "openai:responses" &&
    readSingleHeader(request.headers, "originator")?.trim().toLowerCase() ===
      ARCHESTRA_CODEX_CONNECTION_ORIGINATOR;
  const pluginRegistry = getLlmProxyPluginRegistry();
  const hasProxyPlugins = pluginRegistry.hasPlugins();
  let pluginContext: LlmProxyRequestContext | undefined;
  let pluginSessionInitialized = false;
  const appaIngress = scrubOpenappaIngress({
    request,
    body,
    interactionType: provider.interactionType,
  });

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
  // CLI stamps on every request; OpenCode → "opencode" from its equivalent
  // identity headers; Kilo Code → "kilo" and Cursor → "cursor" from their
  // User-Agents).
  const externalAgentId =
    utils.headers.externalAgentId.getExternalAgentId(headersForExtraction) ??
    utils.headers.clientApp.detectClaudeClientId(bodyForExtraction) ??
    utils.headers.clientApp.detectCodexClientId(
      headersForExtraction,
      bodyForExtraction,
    ) ??
    utils.headers.clientApp.detectOpenCodeClientId(headersForExtraction) ??
    utils.headers.clientApp.detectKiloClientId(headersForExtraction) ??
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
  let serviceAccountId = authOverride?.serviceAccountId;
  let userId = (await utils.headers.userId.getUser(headersForExtraction))
    ?.userId;
  let resolvedUser: LLMProxyContext<TRequest>["resolvedUser"] = userId
    ? await UserModel.getById(userId)
    : null;
  let virtualKeyId = authOverride?.virtualKeyId;
  let passthroughVirtualKeyId: string | undefined;
  // The first credential that names a billing team pays; the passthrough key
  // resolves first, matching its precedence for per-key limits.
  let billingTeamId = authOverride?.billingTeamId;
  let attributionLabels: AttributionLabels | undefined;
  // Authenticated user identities, tracked per source for the consistency check.
  let passthroughUserId: string | undefined;
  let nonOAuthTokenHash: string | undefined;
  let jwksUserId: string | undefined;
  let oauthUserId: string | undefined;
  let regularVirtualKeyUserId: string | undefined;
  let personalTokenUserId: string | undefined;

  // Extract interaction source (chat, chatops, email, etc.)
  // Internal callers set X-Archestra-Source; external API requests default to "api".
  const rawSource = utils.headers.metaHeader.getHeaderValue(
    headersForExtraction,
    SOURCE_HEADER,
  );
  const parsedSource = InteractionSourceSchema.safeParse(rawSource).data;
  const openCodeAgent = utils.headers.metaHeader.getHeaderValue(
    headersForExtraction,
    OPENCODE_AGENT_HEADER,
  );
  const openCodeParentSession = utils.headers.metaHeader.getHeaderValue(
    headersForExtraction,
    "x-parent-session-id",
  );
  // OpenCode and Kilo Code frame their turns the same way; each gets its own
  // source prefix (opencode:main, kilo:main, ...).
  const openCodeSource: InteractionSource | undefined =
    externalAgentId && isOpenCodeFamilyClient(externalAgentId)
      ? openCodeFamilySource(
          externalAgentId,
          openCodeParentSession
            ? "subagent"
            : openCodeAgent === "title"
              ? "title"
              : openCodeAgent === "compaction"
                ? "compaction"
                : "main",
        )
      : undefined;
  const untrustedAppaChatSource =
    isAppaChatSource(parsedSource) && !internalCall;
  // `model_router` is assigned by the route auth override, not accepted from
  // the public source header. APPA-capable Chat sources have the same
  // internal-proof-only trust boundary.
  const source: InteractionSource =
    authOverride?.source ??
    openCodeSource ??
    (parsedSource === "model_router" || untrustedAppaChatSource
      ? "api"
      : parsedSource) ??
    "api";

  // Session extraction reuses the resolved client attribution above to gate
  // OpenCode- and Codex-specific signals, so client identification lives in one place.
  const { sessionId, sessionSource } = followAppaSessionHeader({
    headers: headersForExtraction,
    source,
    ordinarySession: utils.headers.sessionId.extractSessionInfo({
      headers: headersForExtraction,
      body: bodyForExtraction,
      externalAgentId,
    }),
  });

  // Extract W3C trace context (traceparent/tracestate) from incoming request headers.
  // When the chat route calls the LLM proxy via localhost, the traced fetch injects these
  // headers so the LLM span becomes a child of the chat parent span.
  // For external API calls (no traceparent header), this returns root context (unchanged behavior).
  const parentContext = propagation.extract(
    otelContext.active(),
    request.headers,
  );

  // Removes gateway tool attestation markers from the body in place
  // before adapters, logs, provider requests, or database records access them.
  const gatewayToolDeclarations =
    utils.gatewayToolDeclarations.extractGatewayToolDeclarations(body);
  const requestAdapter = provider.createRequestAdapter(body);
  const streamAdapter = provider.createStreamAdapter(body);
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

  let oauthTokenCandidate: string | undefined;
  if (passthroughVirtualKeyToken && !authOverride) {
    try {
      const candidate = normalizeVirtualKeyCandidate(
        provider.extractApiKey(headers),
      );
      if (candidate && !hasArchestraTokenPrefix(candidate))
        oauthTokenCandidate = candidate;
    } catch {
      // Optional prefetch; normal extraction below retains its error ordering.
    }
  }
  // Recently validated credentials already skip the failure-bucket read. Fetch
  // their gateway and owner in one fresh statement; authorization is still
  // checked below, after rate limiting. Cold and explicit-agent paths are unchanged.
  const authenticationSnapshot =
    !agentId &&
    passthroughVirtualKeyToken &&
    !authOverride &&
    virtualKeyRateLimiter.hasRecentValidation(passthroughVirtualKeyToken)
      ? await readPassthroughAuthenticationSnapshot({
          tokenValue: passthroughVirtualKeyToken,
          oauthTokenCandidate,
        })
      : undefined;
  const resolvedAgent =
    authenticationSnapshot?.agent ?? (await resolveAgent(agentId));
  const resolvedAgentId = resolvedAgent.id;
  // Pre-call reads shared within this request only; never stored or reused.
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
        oauthTokenCandidate,
        authenticationSnapshot,
      });
      await virtualKeyRateLimiter.recordSuccess({
        credential: passthroughVirtualKeyToken,
      });
      passthroughVirtualKeyId = passthroughResult.passthroughVirtualKeyId;
      passthroughUserId = passthroughResult.userId;
      nonOAuthTokenHash = passthroughResult.nonOAuthTokenHash;
      billingTeamId ??= passthroughResult.billingTeamId;
      // Authenticated identity → overrides the unauthenticated X-Archestra-User-Id.
      userId = passthroughResult.userId;
      resolvedUser = passthroughResult.user;
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

  // A ChatGPT bearer requires user and proxy-access checks before Archestra
  // sends it to the subscription endpoint instead of api.openai.com.
  if (
    !authOverride &&
    !passthroughVirtualKeyId &&
    provider.provider === "openai" &&
    provider.interactionType === "openai:responses" &&
    isCodexOriginator(readSingleHeader(request.raw.headers, "originator")) &&
    isJwtLike(
      readSingleHeader(request.raw.headers, "authorization")?.match(
        /^Bearer\s+([^\s]+)$/i,
      )?.[1] ?? "",
    )
  ) {
    throw new ApiError(
      401,
      "Codex ChatGPT login requires a passthrough virtual key.",
    );
  }

  // The client owns refresh and rotation for this access token. Keep the
  // credential in request-local client options. Never resolve or save it as
  // an Archestra-managed provider credential.
  const openAiCodexPassthrough = passthroughVirtualKeyId
    ? resolveOpenAiCodexPassthrough({
        provider,
        headers: request.raw.headers,
      })
    : undefined;

  // Authenticate and resolve API key (JWKS → virtual key → header extraction → keyless check)
  let apiKey: string | undefined;
  let perKeyBaseUrl: string | undefined;
  let perKeyProviderApiKeyRow: Awaited<
    ReturnType<typeof LlmProviderApiKeyModel.findById>
  > = null;
  /**
   * The chat_api_key row ID for this call, if the call resolved through a
   * DB-managed key OR was forwarded by an in-process caller via
   * CHAT_API_KEY_ID_HEADER. Used at the bottom of the handler to look up
   * extra HTTP headers. `undefined` for raw-bearer calls from external IPs.
   */
  let perKeyChatApiKeyId: string | undefined;
  let perKeyChatApiKeyIdFromInternalHeader = false;
  let wasJwksAuthenticated = false;
  let wasVirtualKeyResolved = false;
  /** The pool a virtual key with no key of this provider was let in for. */
  let virtualKeyOnlyPoolId: string | undefined;
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
    const jwksResult = openAiCodexPassthrough
      ? null
      : await attemptJwksAuth(request, resolvedAgent, providerName);
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

  // In-process callers forward a stored provider secret through the local
  // proxy (with the in-process proof) tagged with CHAT_API_KEY_ID_HEADER and
  // a downstream PROVIDER_BASE_URL_HEADER. That secret can itself be an `arch_*` virtual key
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
    internalCall &&
    typeof chatApiKeyIdHeader === "string" &&
    chatApiKeyIdHeader.length > 0 &&
    typeof providerBaseUrlHeaderValue === "string" &&
    providerBaseUrlHeaderValue.length > 0;

  if (
    !wasJwksAuthenticated &&
    !authOverride &&
    !openAiCodexPassthrough &&
    rawApiKey &&
    !hasArchestraTokenPrefix(rawApiKey)
  ) {
    const oauthResult = await validateLlmOAuthAccessToken({
      tokenValue: rawApiKey,
      nonOAuthTokenHash,
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
      billingTeamId ??= oauthResult.billingTeamId;
      serviceAccountId = oauthResult.serviceAccountId;
      if (oauthResult.userId) {
        oauthUserId = oauthResult.userId;
        userId = oauthResult.userId;
        resolvedUser = await UserModel.getById(userId);
      }
    }
  }
  // Personal platform token (the credential the MCP gateway accepts). The
  // caller is that user, and the upstream key is the provider key named by
  // CHAT_API_KEY_ID, only when the user may use it. In-process chat already
  // resolved that key for the user with `getCurrentApiKey`, which also admits
  // the agent's configured key through agent access, so a call carrying the
  // in-process proof keeps that decision instead of re-checking key grants.
  if (
    !wasJwksAuthenticated &&
    !authOverride &&
    rawApiKey &&
    hasArchestraTokenPrefix(rawApiKey)
  ) {
    const personalToken = await UserTokenModel.validateToken(rawApiKey);
    if (personalToken) {
      const chatKeyIdHeader =
        headersForExtraction[CHAT_API_KEY_ID_HEADER.toLowerCase()];
      if (typeof chatKeyIdHeader !== "string" || !chatKeyIdHeader) {
        throw new ApiError(
          400,
          `Missing ${CHAT_API_KEY_ID_HEADER} header naming the provider key to use.`,
        );
      }
      const providerKey =
        await LlmProviderApiKeyModel.findById(chatKeyIdHeader);
      if (
        !providerKey ||
        providerKey.organizationId !== resolvedAgent.organizationId ||
        personalToken.organizationId !== resolvedAgent.organizationId ||
        (!internalCall &&
          !(await LlmProviderApiKeyModel.canUseKey(
            providerKey,
            personalToken.userId,
            [],
          )))
      ) {
        throw new ApiError(
          403,
          "The token's user may not use this provider key.",
        );
      }
      if (providerKey.provider !== providerName) {
        throw new ApiError(
          400,
          `Provider key is not for provider "${providerName}".`,
        );
      }
      personalTokenUserId = personalToken.userId;
      userId = personalToken.userId;
      resolvedUser = await UserModel.getById(userId);
      apiKey = providerKey.secretId
        ? await getSecretValueForLlmProviderApiKey(providerKey.secretId)
        : undefined;
      perKeyBaseUrl =
        providerKey.inferenceBaseUrl ?? providerKey.baseUrl ?? perKeyBaseUrl;
      perKeyChatApiKeyId = providerKey.id;
      perKeyProviderApiKeyRow = providerKey;
    }
  }

  if (
    !wasJwksAuthenticated &&
    !authOverride &&
    !personalTokenUserId &&
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
        requestedModel: requestAdapter.getModel(),
        allowModelPool: true,
      });
      await virtualKeyRateLimiter.recordSuccess({ credential: rawApiKey });
      apiKey = virtualResult.apiKey;
      perKeyBaseUrl = virtualResult.baseUrl;
      perKeyChatApiKeyId = virtualResult.chatApiKeyId;
      wasVirtualKeyResolved = true;
      virtualKeyId = virtualResult.virtualKeyId;
      serviceAccountId = virtualResult.serviceAccountId;
      billingTeamId ??= virtualResult.billingTeamId;
      virtualKeyOnlyPoolId = virtualResult.modelPoolId;
      // A personal standard virtual key identifies its owner; include it in the
      // cross-credential consistency check.
      if (virtualResult.virtualKeyIsPersonal) {
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
  // forward the resolved chat_api_keys row ID via a proof-gated header so
  // the proxy can pick up per-key configuration (extraHeaders) below.
  // External clients must NOT be able to spoof this — same SSRF reasoning
  // as PROVIDER_BASE_URL_HEADER.
  if (!perKeyChatApiKeyId) {
    const headerValue =
      headersForExtraction[CHAT_API_KEY_ID_HEADER.toLowerCase()];
    const headerPresent =
      typeof headerValue === "string" && headerValue.length > 0;
    if (internalCall) {
      if (headerPresent) {
        perKeyChatApiKeyId = headerValue;
        perKeyChatApiKeyIdFromInternalHeader = true;
        logger.info(
          { chatApiKeyId: perKeyChatApiKeyId },
          `[${providerName}Proxy] received provider-api-key-id header`,
        );
      }
    } else if (headerPresent) {
      logger.warn(
        { ip: request.socket.remoteAddress },
        `[${providerName}Proxy] ignoring provider-api-key-id header without internal proof`,
      );
    }
  }

  if (perKeyChatApiKeyId && perKeyChatApiKeyIdFromInternalHeader) {
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

  // 5. Enforce a platform credential on external requests (rules in
  // assertPlatformAuthenticated). The organization setting is read only when
  // nothing else authenticates the request.
  await assertPlatformAuthenticated({
    apiKey,
    hasPlatformCredential:
      wasVirtualKeyResolved ||
      wasOAuthAuthenticated ||
      personalTokenUserId !== undefined,
    wasPassthroughKeyValidated: passthroughVirtualKeyId !== undefined,
    wasJwksAuthenticated,
    isInternalCall: internalCall,
    providerSuppliesServerCredential:
      providerSuppliesServerCredential(providerName),
    allowsUnauthenticated: () =>
      OrganizationModel.allowsUnauthenticatedLlmProxyRequests(
        resolvedAgent.organizationId,
      ),
  });

  // All authenticated user-scoped credentials must resolve to the same user.
  assertConsistentUserCredentials([
    passthroughUserId,
    jwksUserId,
    oauthUserId,
    personalTokenUserId,
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
    personalTokenUserId ??
    regularVirtualKeyUserId;

  // Fall back to the personal standard virtual key's owner for user attribution.
  // Higher-precedence sources — the passthrough key, JWKS, OAuth, and the
  // X-Archestra-User-Id header — already set `userId` above, so this only fills
  // the gap when a personal virtual key is the sole identity signal. That is the
  // virtual-key connection mode: the connect flow mints a personal virtual key
  // whose author is the acting user (Codex ChatGPT subscription, Claude Code
  // virtual key). Consistency with any other authenticated identity was just
  // asserted, so this can never disagree with them.
  if (serviceAccountId && authenticatedUserId) {
    throw new ApiError(
      401,
      "Credentials identify both a user and a service account.",
    );
  }
  if (serviceAccountId) {
    // A caller-supplied user hint cannot change the credential's principal.
    userId = undefined;
    resolvedUser = null;
  }
  if (!userId && regularVirtualKeyUserId) {
    userId = regularVirtualKeyUserId;
    resolvedUser = await UserModel.getById(userId);
  }

  if (!authMethod) {
    authMethod = passthroughVirtualKeyId
      ? "passthrough_virtual_key"
      : internalCall
        ? "internal"
        : personalTokenUserId
          ? "personal_token"
          : "provider_key";
  }

  // Encrypted chat sessions: interaction rows keep all usage/cost/session
  // metadata, but their content-bearing fields are encrypted under the
  // conversation's browser-held key (or redacted if that cannot be done
  // safely), and span content capture is suppressed either way. Resolved once
  // up front (server-derived, fail closed) so the catch below and both stream
  // handlers agree on it.
  const encryptedChat = await resolveEncryptedChatAuditContext({
    source,
    // The in-process proof, not the socket: this seam must only ever match a
    // call this process made itself (the in-app chat).
    internalCall,
    sessionId,
    userId,
    dek: readEncryptedChatDek(request),
  });
  // Content never reaches spans or logs for an encrypted-chat session or a
  // deployment whose Log Content mode is Metadata only.
  const isEncryptedChatSession = encryptedChat.kind !== "none";
  const suppressContent =
    isEncryptedChatSession || resolveLogContentMode() === "metadata_only";
  const actualModel = stripClaudeContextVariantSuffix(
    requestAdapter.getModel(),
  );
  const requestContext = await readProxyRequestState({
    organizationId: resolvedAgent.organizationId,
    provider: providerName,
    modelId: actualModel,
    agentId: resolvedAgent.id,
    environmentId: resolvedAgent.environmentId,
    limitVirtualKeyId: virtualKeyId,
    passthroughVirtualKeyId,
    llmOauthClientId: authenticatedApp?.id,
    includeRuntime: hasProxyPlugins && enterpriseTier.isOpenappaActive(),
    userId,
    billingTeamId,
    virtualKeyId:
      authMethod === "virtual_key"
        ? virtualKeyId
        : authMethod === "passthrough_virtual_key"
          ? passthroughVirtualKeyId
          : undefined,
    oauthClientId:
      authMethod === "oauth_client_credentials"
        ? authenticatedApp?.id
        : undefined,
  });
  const {
    active: appaActive,
    featureEnabled: appaFeatureEnabled,
    unsupportedClientAction,
  } = await getGuardrailsDeploymentFromSnapshot({
    row: requestContext.guardrails,
  });
  // Enforcement is off, but OpenAPPA records what it must know when enforcement
  // turns on: the sessions that start now, and the calls governed sessions make.
  // The records hold ids only, so they cover encrypted chats too.
  const appaObserving = appaFeatureEnabled && !appaActive;
  enterOpenappaEncryptedChat(
    encryptedChat.kind === "encrypt" && userId
      ? {
          organizationId: resolvedAgent.organizationId,
          userId,
          audit: encryptedChat.audit,
        }
      : null,
  );

  const attributedAppId = await resolveAttributedAppId(
    request,
    resolvedAgent,
    internalCall,
  );

  const upstreamAttempt: UpstreamAttempt = {
    providerApiKeyId: perKeyChatApiKeyId,
  };
  try {
    // A redacted audit context cannot retain an enforceable trajectory safely.
    if (
      appaActive &&
      encryptedChat.kind === "redact" &&
      !(
        sessionId &&
        (await startedUnenforced({
          organization_id: resolvedAgent.organizationId,
          session_id: sessionId,
        }))
      )
    ) {
      throw new ApiError(
        409,
        "Encrypted chat key and escrow are required for policy storage",
      );
    }
    if (
      provider.unavailableUsageAccounting &&
      config.llmProxy.usageAccountingMode === "enforce"
    ) {
      throw new ApiError(
        422,
        "Authoritative usage and cost accounting are unavailable for this media operation",
      );
    }
    // Check usage limits
    logger.debug(
      { resolvedAgentId },
      `[${providerName}Proxy] Checking usage limits`,
    );
    const limitViolation =
      await LimitValidationService.checkLimitsBeforeRequest({
        unpricedMediaModel: provider.unavailableUsageAccounting
          ? requestAdapter.getModel()
          : undefined,
        agentId: resolvedAgentId,
        userId,
        virtualKeyId,
        passthroughVirtualKeyId,
        llmOauthClientId: authenticatedApp?.id,
        billingTeamId,
        agent: resolvedAgent,
        snapshot: requestContext,
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

    // Internal Chat requests arrive over loopback without platform credentials.
    // Requests that include organization credentials and name a Chat source
    // are treated as client requests. Their sessions scope to the credential
    // rather than a conversation.
    const isInternalChat =
      isAppaChatSource(source) &&
      internalCall &&
      !((authenticatedApp || virtualKeyId) && !authenticatedUserId);

    // Identifies which declared tools the platform gateway served after
    // verifying attestations with the organization key.
    const clientBindings = await resolveClientGatewayBindings({
      evidence: clientRuntimeEvidence,
      organizationId: resolvedAgent.organizationId,
      llmProxyId: resolvedAgent.id,
    });
    const toolIdentity =
      await utils.gatewayToolNames.resolveGatewayToolIdentity({
        organizationId: resolvedAgent.organizationId,
        declarations: gatewayToolDeclarations,
        internalChat: isInternalChat,
        clientBindings,
      });

    // Persist tools declared by client (only for llm_proxy agents)
    if (resolvedAgent.agentType === "llm_proxy") {
      const tools = requestAdapter.getTools();
      if (tools.length > 0) {
        logger.debug(
          { toolCount: tools.length },
          `[${providerName}Proxy] Processing tools from request`,
        );
        await utils.tools.persistTools({
          tools: tools.map((t) => ({
            toolName: t.name,
            toolParameters: t.inputSchema,
            toolDescription: t.description,
            // With attestations, tools served by the gateway are identified
            // regardless of client labels. Unattested lookalikes are discovered
            // as foreign tools.
            ...(toolIdentity.mode === "attested" && !isInternalChat
              ? {
                  servedByGateway:
                    toolIdentity.attestationOf(t.name) !== undefined,
                }
              : {}),
          })),
          agentId: resolvedAgentId,
          observer: { userId, externalAgentId },
        });
      }
    }

    // A request for a model pool's name is served by the pool's members when
    // the caller may use the pool (see `mayUseModelPool`). Members on a wire
    // the client's can't reach are left out of the plan.
    const poolWire = openAiCodexPassthrough
      ? null
      : inboundPoolWire(provider.interactionType);
    const modelPoolPlan = poolWire
      ? await planModelPool({
          organizationId: resolvedAgent.organizationId,
          name: actualModel,
          inbound: poolWire,
          caller: {
            virtualKeyId: virtualKeyId ?? passthroughVirtualKeyId,
            providerApiKeyIds: perKeyChatApiKeyId ? [perKeyChatApiKeyId] : [],
          },
          grantedPoolId: authOverride?.modelPoolId ?? virtualKeyOnlyPoolId,
          sessionId,
        })
      : null;
    // A virtual key let in only for its pool has no key for this provider, so
    // the request can't go anywhere but the pool.
    if (virtualKeyOnlyPoolId && !modelPoolPlan) {
      throw new ApiError(
        400,
        `Virtual API key is not mapped to provider "${providerName}".`,
      );
    }

    // The catalog identity and independent metadata were read together after
    // authentication. A first sighting still creates/enriches the model here.
    // A pool's name is not a provider model; each member's own model is priced
    // instead.
    const catalogModel = requestContext.model;
    const discovered =
      modelPoolPlan || catalogModel
        ? []
        : [
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
        reply.raw.writeHead(200, sseHeaders);
        streamTiming.firstByteAt = Date.now();
      }
    };

    // Fetch the agent's teams (with labels) once for trace span team attributes.
    const teams = requestContext.agentTeams;

    const userTeams = requestContext.userTeams;

    // Enforce model permissions before any upstream call. Checked on the model
    // actually being invoked (post cost-optimization rewrite), and against the
    // AUTHENTICATED identity only — `userId` above can be seeded with the
    // X-Archestra-User-Id header, so it must not decide access.
    const modelTeamAccess = await utils.checkModelTeamAccess({
      provider: providerName,
      modelId: actualModel,
      organizationId: resolvedAgent.organizationId,
      authenticatedUserId,
      catalogModel: catalogModel ?? undefined,
      policySnapshot: catalogModel
        ? {
            organizationId: resolvedAgent.organizationId,
            modelId: catalogModel.id,
            policies: requestContext.modelPolicies,
          }
        : undefined,
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

    let pluginToolResultsOutcome:
      | Awaited<ReturnType<LlmProxyPluginRegistry["onToolResults"]>>
      | undefined;
    let admission: OpenappaAdmission = { kind: "ungoverned" };
    let governedThread: GovernedThread | undefined;
    let appaReceipts: OpenappaReceipts | undefined;
    const installerSetupBypass = await resolveInstallerSetupBypass({
      request,
      body,
      agent: resolvedAgent,
      virtualKeyIds: [virtualKeyId, passthroughVirtualKeyId],
      appaActive,
    });
    if (hasProxyPlugins) {
      admission = await admitOpenappaRequest({
        request,
        body,
        originalRequest: requestAdapter.getOriginalRequest(),
        interactionType: provider.interactionType,
        agent: resolvedAgent,
        principal: {
          authenticatedUserId,
          authenticatedApp,
          virtualKeyId,
          passthroughVirtualKeyId,
          userId,
        },
        deployment: {
          active: appaActive,
          observing: appaObserving,
          unsupportedClientAction,
        },
        chatSource: isInternalChat ? source : undefined,
        externalAgentId,
        inProcessRequest: internalCall,
        internalCall: proof.guardrail,
        installerSetupBypass,
        ingress: appaIngress,
        toolIdentity,
        runtimeSnapshot: requestContext.runtimeSnapshot,
      });
      pluginContext = {
        requestId: request.id,
        organizationId: resolvedAgent.organizationId,
        profileId: resolvedAgent.id,
        ...(userId ? { userId } : {}),
        provider: providerName,
        interactionType: provider.interactionType,
        model: actualModel,
        streaming: requestAdapter.isStreaming(),
        headers: request.headers,
        requestBody: requestAdapter.getOriginalRequest(),
        resources: new Map(),
      };
      if (admission.kind !== "ungoverned") {
        const prepared = await prepareOpenappaRequest({
          admission,
          context: pluginContext,
          body,
          ingress: appaIngress,
          tools: {
            identity: toolIdentity,
            declarations: gatewayToolDeclarations,
            clientBindings,
          },
        });
        if (prepared.kind === "replay")
          // Sent as is: the client reads the provider's own error shape,
          // which the route's error schema would reduce to message and type.
          return reply
            .status(prepared.status)
            .serializer((payload: unknown) => JSON.stringify(payload))
            .send(prepared.body);
        governedThread = prepared.thread;
      }
      await pluginRegistry.onSessionInit(pluginContext);
      pluginSessionInitialized = true;
      pluginToolResultsOutcome = await pluginRegistry.onToolResults({
        ...pluginContext,
        // Adapters can defer wire updates until serialization; pass the filtered
        // content explicitly so APPA cannot inspect a blocked/raw version.
        toolResults: requestAdapter.getToolResults(),
      });
      appaReceipts = await OpenappaReceipts.prepare({
        context: pluginContext,
        body,
        admission,
        clientCompaction: appaIngress.clientCompaction,
      });
    }
    // Nothing OpenAPPA wrote for the client and the gateway goes on to the
    // provider, whether or not this request has a session (deployment switch
    // off, a connection-setup or unsupported-client bypass, a delegated run)
    // and whatever restoration above could not put back. Runs after
    // prepareAppaRequest collected the notices' signed offers and the plugin
    // read this request's results. It changes no call id, so the tool-result updates below still land.
    const providerBoundRewrites = sanitizeProviderBoundRequest({
      body,
      interactionType: provider.interactionType,
      identity: toolIdentity,
    });
    if (providerBoundRewrites > 0) {
      logger.debug(
        {
          resolvedAgentId,
          rewrites: providerBoundRewrites,
          openappaSession: admission.kind === "governed",
        },
        `[${providerName}Proxy] Removed OpenAPPA transport members from the provider-bound request`,
      );
    }
    const toolResultUpdates = Object.fromEntries(
      Object.entries(pluginToolResultsOutcome?.toolResultUpdates ?? {}).map(
        // Approved outputs are rendered from results as the client sent them:
        // a trajectory stamp one echoed still never reaches the provider.
        ([id, content]) => [id, restoreTrajectoryStampText(content)],
      ),
    );

    // Apply tool result updates
    requestAdapter.applyToolResultUpdates(toolResultUpdates);

    logger.debug(
      {
        resolvedAgentId,
        toolResultUpdatesCount: Object.keys(toolResultUpdates).length,
      },
      "Tool results updated by proxy plugins",
    );

    // Read per-key base URL override from header, but ONLY from internal (localhost) requests.
    // External clients must NOT be able to set this header — it would be an SSRF vector
    // (attacker could redirect the proxy to arbitrary URLs like cloud metadata endpoints).
    const providerBaseUrlHeader =
      internalCall &&
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
      logger.debug(
        `[${providerName}Proxy] no chat_api_key id, skipping db header lookup`,
      );
    }
    // Merge per-key extra headers behind any provider-forwarded headers
    // (anthropic-beta etc.) so protocol-level headers always win.
    const mergedHeaders: Record<string, string> = {
      ...(perKeyExtraHeaders ?? {}),
      ...headersToForward,
    };
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
    const credentialBillingMode = utils.resolveInteractionBillingMode({
      isSubscriptionCredential:
        openAiCodexPassthrough !== undefined ||
        provider.isSubscriptionCredential?.(apiKey) === true,
      autodetectEnabled: config.llmCost.subscriptionAutodetect,
    });
    let billingMode = credentialBillingMode;

    if (providerName === "azure") {
      const original = requestAdapter.getOriginalRequest() as Record<
        string,
        unknown
      >;
      const metadata = original.metadata as Record<string, unknown> | undefined;
      const type = String(provider.interactionType);
      const operation =
        type === "azure:images"
          ? metadata?.operation === "image-edit"
            ? "image-edit"
            : "image-generation"
          : type === "azure:audio"
            ? original.operation === "speech"
              ? "audio-speech"
              : original.operation === "transcriptions"
                ? "audio-transcription"
                : "audio-translation"
            : type === "azure:realtime"
              ? "realtime-turn"
              : provider.spanName === "embedding"
                ? "embedding"
                : type === "azure:responses"
                  ? "responses"
                  : "chat";
      await validateAzureModelOperation({
        providerApiKeyId: perKeyChatApiKeyId,
        modelId: requestAdapter.getModel(),
        operation,
        parameters: original,
      });
    }

    // Create client with observability (each provider handles metrics internally)
    // A guardrail caller disconnects once it stops waiting for the answer,
    // so its upstream call stops too instead of running on and being billed.
    const abortSignal =
      provider.cancelOnDisconnect ||
      providerName === "microsoft-365-copilot" ||
      providerName === "azure" ||
      provider.interactionType === "azure:realtime" ||
      proof.guardrail
        ? clientDisconnectSignal({ request, reply })
        : undefined;
    const createUpstreamClient = (target: {
      adapter: Pick<typeof provider, "createClient" | "provider">;
      apiKey: string | undefined;
      baseUrl: string | undefined;
      headers: Record<string, string>;
      providerApiKeyId: string | undefined;
      model: string;
      /** Aborts this call alone, on top of the request's own signal. */
      attemptSignal?: AbortSignal;
      /** The deployment and query of an Azure-shaped inbound URL. */
      azureRequest?: ReturnType<typeof getAzureProxyIngress>;
    }) =>
      target.adapter.createClient(target.apiKey, {
        ...(target.azureRequest ? { azureRequest: target.azureRequest } : {}),
        baseUrl: target.baseUrl,
        agent: resolvedAgent,
        abortSignal:
          abortSignal && target.attemptSignal
            ? AbortSignal.any([abortSignal, target.attemptSignal])
            : (target.attemptSignal ?? abortSignal),
        source,
        model: target.model,
        defaultHeaders:
          Object.keys(target.headers).length > 0 ? target.headers : undefined,
        llmProviderApiKeyId: target.providerApiKeyId,
        sessionId: sessionId ?? undefined,
        onResponseHeaders: (responseHeaders) => {
          if (target.adapter.provider === "anthropic") {
            billingMode = utils.refineAnthropicBillingModeFromHeaders({
              // A retry's response must not inherit a failed attempt's overage.
              billingMode: credentialBillingMode,
              headers: responseHeaders,
            });
          }
        },
        openAiCodexPassthrough,
        ...(providerName === "gemini" &&
        typeof headersForExtraction["x-goog-user-project"] === "string"
          ? { googleUserProject: headersForExtraction["x-goog-user-project"] }
          : {}),
      });
    // A pooled request never uses the caller's own key, which a Model Router
    // pool request doesn't even carry.
    const client = modelPoolPlan
      ? undefined
      : createUpstreamClient({
          adapter: provider,
          apiKey,
          baseUrl: effectiveBaseUrl,
          headers: mergedHeaders,
          providerApiKeyId: perKeyChatApiKeyId,
          model: requestAdapter.getModel(),
          azureRequest:
            providerName === "azure"
              ? getAzureProxyIngress(request)
              : undefined,
        });

    // Each pool member is reached with its own provider's client, its own
    // model id and, when it speaks another wire, a translator.
    const modelPool: ModelPoolRouting | undefined =
      modelPoolPlan && poolWire
        ? {
            plan: modelPoolPlan,
            transportFor: async (member, signal) => {
              const row = await LlmProviderApiKeyModel.findById(
                member.providerApiKeyId,
              );
              const adapter = memberAdapter(member.provider);
              if (!row || !adapter) {
                throw new ApiError(
                  500,
                  "Model pool member key no longer exists",
                );
              }
              const sameWire =
                inboundPoolWire(adapter.interactionType) === poolWire;
              return memberTransport({
                inbound: poolWire,
                provider: member.provider,
                modelId: member.modelId,
                client: createUpstreamClient({
                  adapter,
                  apiKey: row.secretId
                    ? await getSecretValueForLlmProviderApiKey(row.secretId)
                    : undefined,
                  baseUrl:
                    row.inferenceBaseUrl ?? row.baseUrl ?? adapter.getBaseUrl(),
                  // Protocol headers (anthropic-beta, ...) only mean something
                  // to a member on the client's own wire.
                  headers: {
                    ...(row.extraHeaders ?? {}),
                    ...(sameWire ? headersToForward : {}),
                  },
                  providerApiKeyId: row.id,
                  model: member.modelId,
                  attemptSignal: signal,
                }),
              });
            },
            recordFailedAttempt: async (attempt) => {
              const cutOff = attempt.cutOff
                ? await estimateCutOffAttemptUsage({
                    provider: providerName,
                    providerMessages: requestAdapter.getProviderMessages(),
                    tools: requestAdapter.getTools(),
                    member: attempt,
                  })
                : undefined;
              await persistProxyInteraction({
                record: {
                  profileId: resolvedAgent.id,
                  externalAgentId,
                  runId,
                  userId,
                  serviceAccountId,
                  virtualKeyId,
                  passthroughVirtualKeyId,
                  appId: attributedAppId,
                  sessionId,
                  sessionSource,
                  source,
                  authMethod,
                  authenticatedAppId: authenticatedApp?.id,
                  authenticatedAppName: authenticatedApp?.name,
                  billingTeamId,
                  type: provider.interactionType,
                  request:
                    requestAdapter.getOriginalRequest() as InteractionRequest,
                  processedRequest: null,
                  response: { error: attempt.failureReason ?? "failed" },
                  model: actualModel,
                  baselineModel: actualModel,
                  // A refused attempt is free. One we cut off had read the
                  // prompt, so it carries that input as an estimate.
                  inputTokens: cutOff?.inputTokens ?? 0,
                  inputTokensEstimated: cutOff !== undefined,
                  outputTokens: 0,
                  cost: cutOff ? cutOff.cost : "0",
                  baselineCost: cutOff?.cost,
                },
                encryptedChat,
                streamTiming,
                attributionLabels,
                upstreamAttempt: attempt,
              });
            },
            setResponseHeaders: (attempt) => {
              if (reply.raw.headersSent) return;
              reply.raw.setHeader("x-archestra-pool", modelPoolPlan.poolName);
              reply.raw.setHeader(
                "x-archestra-attempts",
                String(attempt.attempt ?? 1),
              );
              if (attempt.providerApiKeyId) {
                reply.raw.setHeader(
                  "x-archestra-provider-key",
                  attempt.providerApiKeyId,
                );
              }
            },
          }
        : undefined;

    if (pluginContext) {
      await pluginRegistry.onPrompt({
        ...pluginContext,
        prompt: requestAdapter.getProviderMessages(),
      });
    }

    // Build final request
    const builtRequest = requestAdapter.toProviderRequest();
    governedThread?.restoreProviderRequest(builtRequest);

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
    const providerRequest =
      providerName === "anthropic" &&
      externalAgentId === CLAUDE_DESKTOP_CLIENT_ID &&
      provider.isSubscriptionCredential?.(apiKey) === true
        ? withClaudeDesktopSubscriptionPreamble(repairedRequest)
        : repairedRequest;

    // A connection probe is not an agent task. This is request-local and does
    // not alter the client's model, sandbox, approval policy or configuration.
    const finalRequest = (
      connectionVerification
        ? { ...asRecord(providerRequest), tool_choice: "none" }
        : providerRequest
    ) as TRequest;

    // The tool names the request declares, in the canonical form tool-call
    // names are compared in. Read from the request body rather than
    // `getTools()`, which keeps only schema-carrying function tools: a tool the
    // caller declared and executes itself (Anthropic's bash/text_editor/
    // computer, OpenAI chat `custom` tools, every non-function tool on the
    // Responses surface) is absent from that list but is still declared.
    //
    // Includes Codex namespace members resolved within their declared namespaces.
    // Evaluated after removing the OpenAPPA notice tool from the request body.
    const enabledToolNames = new Set(
      utils
        .collectDeclaredToolNames(requestAdapter.getOriginalRequest())
        .map(({ name, namespace }) =>
          toolIdentity.canonicalize(name, namespace),
        ),
    );

    const billingEntities: BillingAttribution["entities"] = [
      { entityType: "organization", entityId: resolvedAgent.organizationId },
      { entityType: "agent", entityId: resolvedAgent.id },
      ...(billingTeamId ? [billingTeamId] : teams.map((team) => team.id)).map(
        (entityId) => ({ entityType: "team" as const, entityId }),
      ),
    ];
    for (const [entityType, entityId] of [
      ["user", billingTeamId ? undefined : userId],
      ["virtual_key", virtualKeyId],
      ["virtual_key", passthroughVirtualKeyId],
      ["llm_oauth_client", authenticatedApp?.id],
      ["environment", resolvedAgent.environmentId],
    ] as const)
      if (entityId) billingEntities.push({ entityType, entityId });
    const uniqueBillingEntities = new Map(
      billingEntities.map((entity) => [
        `${entity.entityType}:${entity.entityId}`,
        entity,
      ]),
    );
    attributionLabels = await resolveRequestAttributionLabels(
      {
        organizationId: resolvedAgent.organizationId,
        authMethod,
        virtualKeyId,
        passthroughVirtualKeyId,
        oauthClientId: authenticatedApp?.id,
        billingTeamId,
      },
      requestContext.attributionRows,
    );
    const ctx: LLMProxyContext<TRequest> = {
      attributionLabels,
      throughput: new LlmThroughput({
        entities: [...uniqueBillingEntities.values()],
        model: actualModel,
        provider: providerName,
        subscription: billingMode === "subscription",
        rules: requestContext.throughputRules,
      }),
      usageAccountingMode: config.llmProxy.usageAccountingMode,
      providerApiKeyId: perKeyChatApiKeyId,
      upstreamAttempt,
      ...(modelPool ? { modelPool } : {}),
      billingAttribution: {
        organizationId: resolvedAgent.organizationId,
        environmentId: resolvedAgent.environmentId,
        entities: [...uniqueBillingEntities.values()],
      },
      connectionVerification,
      ...(appaReceipts ? { appaReceipts } : {}),
      ...(governedThread ? { governedThread } : {}),
      ...(pluginContext ? { pluginRegistry, pluginContext } : {}),
      agent: resolvedAgent,
      originalRequest: requestAdapter.getOriginalRequest(),
      actualModel,
      enabledToolNames,
      toolIdentity,
      suppressContent,
      encryptedChat,
      appId: attributedAppId,
      externalAgentId,
      authMethod,
      billingMode,
      getBillingMode: () => billingMode,
      authenticatedApp,
      billingTeamId,
      userId,
      serviceAccountId,
      resolvedUser,
      virtualKeyId,
      passthroughVirtualKeyId,
      sessionId,
      sessionSource,
      source,
      runId,
      parentContext,
      teams,
      userTeams,
      streamTiming,
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
    const lifecycleError = error;
    if (lifecycleError instanceof RecordedCodexGenerationFailure) {
      return handleError(
        lifecycleError,
        reply,
        provider.extractErrorMessage,
        false,
        provider.extractInternalCode.bind(provider),
        provider.formatStreamErrorFrame,
        provider.translatesWireFormat,
      );
    }
    if (pluginContext && pluginSessionInitialized) {
      try {
        pluginSessionInitialized = false;
        await pluginRegistry.fail({ ...pluginContext, error });
      } catch (pluginError) {
        logger.warn(
          { err: pluginError },
          "Plugin cleanup failed while handling proxy error",
        );
      }
    }
    if (
      (lifecycleError instanceof ObservedProviderUsageError &&
        lifecycleError.billingRecorded) ||
      (lifecycleError instanceof ThroughputError &&
        lifecycleError.interactionRecorded)
    )
      return handleError(
        lifecycleError,
        reply,
        provider.extractErrorMessage,
        false,
        provider.extractInternalCode.bind(provider),
        provider.formatStreamErrorFrame,
        provider.translatesWireFormat,
      );
    // Persist failed interactions so they appear in LLM logs
    try {
      const errorMessage = upstreamErrorMessage(
        lifecycleError,
        provider.extractErrorMessage,
      );
      // Provider errors routinely echo the prompt back.
      logger.info(
        {
          profileId: resolvedAgent.id,
          ...(suppressContent ? {} : { errorMessage }),
        },
        "Persisting error interaction record",
      );
      const record: InsertInteraction = {
        profileId: resolvedAgent.id,
        externalAgentId,
        runId,
        userId,
        serviceAccountId,
        virtualKeyId,
        passthroughVirtualKeyId,
        appId: attributedAppId,
        sessionId,
        sessionSource,
        source,
        authMethod,
        authenticatedAppId: authenticatedApp?.id,
        authenticatedAppName: authenticatedApp?.name,
        billingTeamId,
        type: provider.interactionType,
        request: requestAdapter.getOriginalRequest() as InteractionRequest,
        processedRequest: null,
        response: (provider.unavailableUsageAccounting
          ? withMediaUsageAvailability(
              { error: errorMessage },
              {
                inputTokens: 0,
                outputTokens: 0,
                usageUnavailable: true,
                costUnavailable: true,
              },
            )
          : { error: errorMessage }) as InteractionResponse,
        model: stripClaudeContextVariantSuffix(requestAdapter.getModel()),
        // Mirrors `model`, as every write path does now that nothing rewrites
        // the model in flight. This row carries no cost either way.
        baselineModel: stripClaudeContextVariantSuffix(
          requestAdapter.getModel(),
        ),
        inputTokens: provider.unavailableUsageAccounting ? null : 0,
        outputTokens: provider.unavailableUsageAccounting ? null : 0,
        // A pool member that failed before answering is free, like the
        // attempts before it.
        ...(upstreamAttempt.attemptOutcome === "failed" ? { cost: "0" } : {}),
      };
      await persistProxyInteraction({
        record,
        encryptedChat,
        streamTiming,
        attributionLabels,
        upstreamAttempt,
      });
    } catch (interactionError) {
      logger.error(
        { err: interactionError, profileId: resolvedAgent.id },
        "Failed to create error interaction record",
      );
    }

    return handleError(
      lifecycleError,
      reply,
      provider.extractErrorMessage,
      requestAdapter.isStreaming(),
      provider.extractInternalCode.bind(provider),
      provider.formatStreamErrorFrame,
      provider.translatesWireFormat,
    );
  }
}

/** Checks before provider processing and again at the client-write boundary. */
function assertVerificationResponse(value: unknown): void {
  const record = asRecord(value);
  if (!record)
    throw new ApiError(
      409,
      "Invalid response during Codex connection verification.",
    );
  const type = record.type;
  // This probe permits only text and reasoning. Unknown events fail closed so
  // new provider tool types cannot reach the native dispatcher by default.
  if (
    typeof type === "string" &&
    ![
      "error",
      "response.created",
      "response.in_progress",
      "response.queued",
      "response.completed",
      "response.failed",
      "response.incomplete",
      "response.output_item.added",
      "response.output_item.done",
    ].includes(type) &&
    !/^response\.(output_text|content_part|reasoning|reasoning_text|reasoning_summary_text|reasoning_summary_part|refusal|compaction)\./.test(
      type,
    )
  ) {
    throw new ApiError(
      409,
      "Codex connection verification does not permit model tool calls.",
    );
  }
  const items = [
    ...(record.item !== undefined ? [record.item] : []),
    ...(Array.isArray(record.output) ? record.output : []),
    ...(Array.isArray(asRecord(record.response)?.output)
      ? (asRecord(record.response)?.output as unknown[])
      : []),
  ];
  if (
    items.some(
      (item) =>
        !["message", "reasoning", "compaction"].includes(
          String(asRecord(item)?.type),
        ),
    )
  ) {
    throw new ApiError(
      409,
      "Codex connection verification does not permit model tool calls.",
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
    attributionLabels,
    agent,
    originalRequest,
    actualModel,
    enabledToolNames,
    toolIdentity,
    suppressContent,
    encryptedChat,
    appId,
    externalAgentId,
    authMethod,
    billingMode: initialBillingMode,
    getBillingMode,
    authenticatedApp,
    billingTeamId,
    userId,
    serviceAccountId,
    virtualKeyId,
    passthroughVirtualKeyId,
    resolvedUser,
    sessionId,
    sessionSource,
    source,
    runId,
    parentContext,
    teams,
    userTeams,
    streamTiming,
    pluginRegistry,
    pluginContext,
    appaReceipts,
  } = ctx;

  const providerName = provider.provider;
  const bufferModelResponse =
    pluginContext !== undefined &&
    pluginRegistry?.buffersModelResponse(pluginContext) === true;
  if (pluginContext && pluginRegistry?.governsHostedToolCalls(pluginContext)) {
    streamAdapter.withholdHostedToolCalls?.();
  }
  appaReceipts?.attachToStream(streamAdapter, {
    buffered: bufferModelResponse,
  });
  let billingMode = initialBillingMode;
  const streamStartTime = Date.now();
  let firstChunkTime: number | undefined;
  let streamCompleted = false;
  let failedStreamResponse: unknown;
  let clientGone = false;
  // Set once a terminal reaches the client, whichever path released it: the
  // stream loop, the policy release, or a failed generation. An error frame
  // after it must not end the response a second time.
  const carriesStreamTerminal = provider.carriesStreamTerminal;
  let terminalSent = false;

  // Every byte to the client goes through here so the keep-alive knows when
  // the stream last spoke. The keep-alive itself only ever writes to a stream
  // that is already committed and idle (see StreamKeepAlive) — it is armed
  // now, before the upstream call, so it also covers a stream committed
  // during preflight and a slow post-stream plugin ruling, but it cannot
  // itself turn a pending upstream error into a 200.
  const keepAlive = new StreamKeepAlive(
    reply.raw,
    config.llmProxy.streamKeepAliveIntervalMs,
    streamAdapter
      .getSSEHeaders()
      ["Content-Type"]?.startsWith("text/event-stream") ?? false,
  );
  keepAlive.start();
  const writeToClient = (data: string | Uint8Array) => {
    // A disconnected client can no longer read anything; writing would throw
    // write-after-end. Call sites that gate work on the socket state keep
    // their own checks — this one only skips the write itself.
    if (reply.raw.destroyed) {
      clientGone = true;
      return;
    }
    if (ctx.connectionVerification) {
      // Includes policy-generated frames as well as provider frames. Do not
      // let an executable call reach the native client's dispatcher.
      for (const line of (typeof data === "string"
        ? data
        : Buffer.from(data).toString("utf8")
      ).split("\n")) {
        if (!line.startsWith("data:")) continue;
        const value = line.slice(5).trim();
        if (value && value !== "[DONE]") {
          let frame: unknown;
          try {
            frame = JSON.parse(value);
          } catch {
            throw new ApiError(
              409,
              "Malformed response during Codex connection verification.",
            );
          }
          assertVerificationResponse(frame);
        }
      }
    }
    ensureStreamHeaders();
    reply.raw.write(data);
    keepAlive.touch();
    if (carriesStreamTerminal && !terminalSent)
      terminalSent = carriesStreamTerminal(data);
  };
  const childStream = new BufferedChildStream({
    enabled: bufferModelResponse,
    write: writeToClient,
  });
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
        serviceAccountId,
        virtualKeyId,
        passthroughVirtualKeyId,
        appId,
        sessionId,
        sessionSource,
        source,
        authMethod,
        authenticatedAppId: authenticatedApp?.id,
        authenticatedAppName: authenticatedApp?.name,
        billingTeamId,
        type: provider.interactionType,
        request: originalRequest as InteractionRequest,
        processedRequest: request as InteractionRequest,
        response: (provider.unavailableUsageAccounting
          ? withMediaUsageAvailability(response, {
              inputTokens: 0,
              outputTokens: 0,
              usageUnavailable: true,
              costUnavailable: true,
            })
          : response) as InteractionResponse,
        model: actualModel,
        inputTokens: provider.unavailableUsageAccounting ? null : 0,
        outputTokens: provider.unavailableUsageAccounting ? null : 0,
        toolCallBlock,
      };
      await persistProxyInteraction({
        record,
        encryptedChat,
        streamTiming,
        attributionLabels,
        throughput: ctx.throughput,
        upstreamAttempt: ctx.upstreamAttempt,
      });
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

  let accountingFinalized = false;
  let upstreamFinished = false;
  let providerTerminalSeen = false;
  const finalizeInteraction = async () => {
    if (accountingFinalized) return;
    accountingFinalized = true;
    try {
      await ctx.throughput?.reconcile(streamAdapter.state.usage);
    } catch (error) {
      // A committed stream cannot become an HTTP 503. Preserve interaction
      // accounting and surface the metering failure in server logs.
      logger.error({ err: error }, "Unable to record streaming token usage");
    }

    // Always record interaction (whether stream completed or was aborted)
    if (!upstreamFinished && !streamCompleted) {
      logger.info(
        { clientGone },
        "Stream was aborted before completion, recording partial interaction",
      );
    }

    // Client-visible first byte, preflight included. Observed here rather
    // than at commit time because the commit can happen during preflight,
    // before the handler has the labels in hand.
    if (streamTiming.firstByteAt !== undefined) {
      metrics.llm.reportTimeToFirstByte(
        providerName,
        agent,
        actualModel,
        (streamTiming.firstByteAt - streamTiming.requestReceivedAt) / 1000,
        source,
      );
    }

    let usage = streamAdapter.state.usage;
    if (usage && !upstreamFinished && ctx.usageAccountingMode !== "off") {
      const breakdown =
        usage.billingUsage ?? primaryBillingUsage(usage, actualModel);
      usage = {
        ...usage,
        billingQuote: undefined,
        billingUsage: {
          ...breakdown,
          status: "incomplete",
          issues: [...breakdown.issues, "partial_stream"],
        },
      };
    }
    if (usage) {
      withSessionContext(sessionId, () => {
        if (ctx.usageAccountingMode !== "enforce" && !usage.usageUnavailable)
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
        usageAccountingMode: ctx.usageAccountingMode,
        providerApiKeyId: ctx.providerApiKeyId,
        actualModel: ctx.upstreamAttempt.modelId ?? actualModel,
        usage,
        providerName: ctx.upstreamAttempt.provider ?? providerName,
      });

      withSessionContext(sessionId, () => {
        if (costs.billingUsage?.mode === "enforce") {
          reportBillableUsageMetrics({
            usage: costs.billingUsage,
            agent,
            source,
            billingMode,
            authMethod,
            tokens: true,
          });
          return;
        }
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
          billingAttribution: ctx.billingAttribution,
          agent,
          externalAgentId,
          authMethod,
          billingMode,
          authenticatedApp,
          billingTeamId,
          runId,
          userId,
          serviceAccountId,
          virtualKeyId,
          passthroughVirtualKeyId,
          appId,
          sessionId,
          sessionSource,
          source,
          providerType: provider.interactionType,
          request: originalRequest,
          processedRequest: request,
          response: withProviderToolCallIds(
            failedStreamResponse ?? streamAdapter.toProviderResponse(),
            streamAdapter.state.toolCalls,
          ),
          actualModel,
          usage,
          costs,
          toolCallBlock,
        });
        await persistProxyInteraction({
          record,
          encryptedChat,
          streamTiming,
          attributionLabels,
          throughput: ctx.throughput,
          upstreamAttempt: ctx.upstreamAttempt,
        });
      } catch (interactionError) {
        logger.error(
          { err: interactionError, profileId: agent.id },
          "Failed to create interaction record (agent may have been deleted)",
        );
        if (ctx.usageAccountingMode === "enforce")
          throw new ApiError(503, "Unable to settle LLM usage");
      }
    } else {
      // No usage ever arrived. On the error path the catch has already recorded
      // the failure; otherwise the provider ended the stream early (a truncated
      // response), and the partial content is all we have to log. Either way the
      // call must not disappear from interaction history.
      await recordUsagelessInteraction(
        withProviderToolCallIds(
          failedStreamResponse ?? streamAdapter.toProviderResponse(),
          streamAdapter.state.toolCalls,
        ),
      );
    }
  };

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
      getPromptMessages: () =>
        provider.createRequestAdapter(originalRequest).getProviderMessages(),
      suppressContent,
      parentContext,
      user: toSpanUserInfo(resolvedUser),
      callback: async (llmSpan) => {
        if (pluginRegistry && pluginContext) {
          await pluginRegistry.onBeforeModel({ ...pluginContext, request });
        }
        if (reply.raw.destroyed)
          throw new ApiError(499, "Client disconnected before inference");
        await ctx.throughput?.admit(request);
        if (reply.raw.destroyed) {
          await ctx.throughput?.cancelBeforeSend();
          throw new ApiError(499, "Client disconnected before inference");
        }
        const stream = await openUpstream({
          ctx,
          transport: ownTransport(provider, client),
          open: async (transport) =>
            withFirstChunk(
              (await transport.executeStream(request)) as AsyncIterable<TChunk>,
            ),
          memberTimeoutMs: MODEL_POOL_FIRST_CHUNK_TIMEOUT_MS,
          // Gemini's SDK loses the HTTP status when an error body is cut off;
          // that is indistinguishable from a transport failure, so don't retry.
          isRetryable: (error) =>
            providerName !== "gemini" &&
            isRetryableUpstreamConnectionFailure(error),
          shouldContinue: () => !reply.raw.destroyed,
          onRetry: (event) =>
            logUpstreamRetry({
              ...event,
              provider: providerName,
              model: actualModel,
            }),
        });
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
          if (ctx.connectionVerification) assertVerificationResponse(chunk);
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

          const result = streamAdapter.processChunk(chunk);

          // An adapter reports a tool-call chunk by withholding `sseData`, so
          // the call accumulates and is released, or discarded, once
          // the tool-call plugins have ruled on it. Releasing one earlier would mean
          // predicting the gate's verdict from cheaper signals, and any
          // disagreement hands the client a runnable call the gate refused —
          // the MCP gateway's re-check resolves against the agent's assigned
          // tools and does not re-apply this turn's decision. A refusal covers
          // the whole batch too, so a call released before its siblings arrive
          // could not be taken back.
          //
          // Whatever an adapter does put in `sseData` is forwarded verbatim,
          // so an adapter that emits a chunk carrying both text and a tool call
          // defeats this (gemini.ts, minimax.ts, and openai.ts's `delta.content`
          // branch still do; zhipuai.ts guards it), as does one whose terminal
          // frame echoes the turn's calls (the Responses adapters).
          if (result.sseData) {
            childStream.emitModel(result.sseData, result.isResponsePreamble);
          }

          if (result.isFinal) {
            providerTerminalSeen = true;
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
          const cost = await calculateUsageCost({
            usageAccountingMode: ctx.usageAccountingMode,
            providerApiKeyId: ctx.providerApiKeyId,
            model: ctx.upstreamAttempt.modelId ?? actualModel,
            usage: state.usage,
            provider: ctx.upstreamAttempt.provider ?? providerName,
          });
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

        // Capture streamed completion content (suppressed for encrypted chats)
        if (captureContent && !suppressContent && state.text) {
          llmSpan.addEvent(EVENT_GENAI_CONTENT_COMPLETION, {
            [ATTR_GENAI_COMPLETION]: state.text.slice(0, contentMaxLength),
          });
        }
      },
    });

    // Anthropic requires message_stop; its beta usage arrives before that frame.
    upstreamFinished = providerName !== "anthropic" || providerTerminalSeen;
    if (!upstreamFinished && ctx.usageAccountingMode === "enforce")
      throw new ApiError(
        502,
        "Provider stream ended before final usage was confirmed",
      );
    logger.info("Stream loop completed, processing final events");

    if (
      await failResponsesGeneration({
        response: streamAdapter.toProviderResponse(),
        ctx,
      })
    ) {
      // The adapter holds the failure terminal with any executable fragments.
      // Drop those fragments, not the provider's terminal status or usage.
      if (!streamAdapter.formatToolCallsSSE) {
        throw new ApiError(
          503,
          "LLM provider cannot safely release a failed Responses generation",
        );
      }
      const failureEvents = streamAdapter.formatToolCallsSSE([]);
      childStream.dropModel();
      for (const event of bufferModelResponse
        ? withoutResponsesModelOutputSSE(failureEvents)
        : failureEvents)
        writeToClient(event);
      await finalizeInteraction();
      writeToClient(streamAdapter.formatEndSSE());
      reply.raw.end();
      streamCompleted = true;
      return reply;
    }

    const hostedToolCalls = streamAdapter.getHostedToolCalls?.() ?? [];
    const hostedHold = streamAdapter.formatHeldHostedToolCallsSSE
      ? await holdProxyPluginHostedToolCalls(
          pluginRegistry,
          pluginContext,
          hostedToolCalls,
        )
      : null;
    if (hostedHold && streamAdapter.formatHeldHostedToolCallsSSE) {
      for (const blocked of hostedHold.blocked) {
        recordBlockedToolCallMetrics({
          allToolCallNames: [blocked.name],
          reason: blocked.reason,
          agent,
          teams,
          userTeams,
          sessionId,
          resolvedUser,
          providerName,
          toolCallCount: 1,
          actualModel,
          source,
        });
      }
      toolCallBlock = toToolCallBlock(null, hostedHold.blocked);
      const heldEvents = streamAdapter.formatHeldHostedToolCallsSSE(
        hostedHold.notices,
      );
      if (!reply.raw.destroyed) {
        for (const event of heldEvents) {
          childStream.emitPolicy(event);
        }
      }
    }

    // Let the proxy plugins rule on the turn's tool calls. A held turn's own
    // calls rest on what was withheld, so they went with it.
    const toolCalls = hostedHold ? [] : streamAdapter.state.toolCalls;
    let toolInvocationRefusal: LlmProxyToolCallRefusal | null = null;

    let rewrittenToolCalls: AccumulatedToolCall[] | null = null;

    if (toolCalls.length > 0) {
      rewrittenToolCalls = planDispatchRewrites({
        supported: streamAdapter.formatToolCallsSSE !== undefined,
        toolCalls,
        enabledToolNames,
        toolIdentity,
        providerName,
      });

      logger.info(
        {
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map((tc) => tc.name),
        },
        "Ruling on tool calls with proxy plugins",
      );

      const policyOutcome = await evaluateProxyPluginToolCalls(
        ctx.pluginRegistry,
        ctx.pluginContext,
        rewrittenToolCalls ?? toolCalls,
        streamAdapter.formatToolCallsSSE !== undefined,
        streamAdapter.supportsToolCallReview === true &&
          typeof streamAdapter.formatToolCallsSSE === "function",
      );
      if (policyOutcome.wasRewritten)
        rewrittenToolCalls = policyOutcome.toolCalls;
      toolInvocationRefusal = policyOutcome.refusal;
      // Record metrics for tool calls substituted with denial notices.
      for (const blocked of policyOutcome.blocked) {
        recordBlockedToolCallMetrics({
          allToolCallNames: [blocked.name],
          reason: blocked.reason,
          agent,
          teams,
          userTeams,
          sessionId,
          resolvedUser,
          providerName,
          toolCallCount: 1,
          actualModel,
          source,
        });
      }

      logger.info(
        { refused: !!toolInvocationRefusal },
        "Proxy plugin tool-call ruling",
      );

      toolCallBlock = toToolCallBlock(
        toolInvocationRefusal,
        policyOutcome.blocked,
      );
    }

    await ctx.governedThread?.recordResponse({
      messageId: streamAdapter.state.responseId,
      providerCalls: toolCalls,
      clientCalls: toolInvocationRefusal
        ? []
        : (rewrittenToolCalls ?? toolCalls),
      refused: toolInvocationRefusal !== null,
      held: !!hostedHold,
    });

    if (toolInvocationRefusal) {
      const { contentMessage, reason, allToolCallNames } =
        toolInvocationRefusal;

      const fullContentMessage =
        appaReceipts?.prefixRefusal(contentMessage, {
          buffered: bufferModelResponse,
        }) ?? contentMessage;
      childStream.discard(streamAdapter);
      // Drop the held tool-call events and use the existing refusal format.
      // Its text comes from APPA when enabled.
      const refusalEvents =
        streamAdapter.formatCompleteTextSSE(fullContentMessage);
      for (const event of refusalEvents) {
        childStream.emitPolicy(event);
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
    } else if (
      toolCalls.length > 0 ||
      (!hostedHold && hostedToolCalls.length > 0)
    ) {
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
        // the one the model first wrote - logged under the provider's call
        // ids, as the requests are.
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
          childStream.emitPolicy(event);
        }
      }
    }

    let response = streamAdapter.toProviderResponse();
    let bufferedOutcome:
      | { decision: "release" }
      | { decision: "replace"; responseText: string } = {
      decision: "release",
    };
    if (bufferModelResponse && pluginRegistry && pluginContext) {
      bufferedOutcome = await pluginRegistry.onBufferedModelResponse({
        ...pluginContext,
        response,
        responseText:
          toolInvocationRefusal?.contentMessage ??
          stripChildTrajectoryReceipts(streamAdapter.state.text).text,
      });
      if (bufferedOutcome.decision === "replace") {
        childStream.discard(streamAdapter);
        childStream.replaceResponse(
          streamAdapter.formatCompleteTextSSE(
            appaReceipts?.appendToReplacement(bufferedOutcome.responseText) ??
              bufferedOutcome.responseText,
          ),
        );
        response = streamAdapter.toProviderResponse();
      }
    }

    // Evaluates plugins on buffered child responses before release.
    // If a plugin rejects the response, unapproved output does not reach the client.
    if (pluginRegistry && pluginContext) {
      await pluginRegistry.onModelResponse({
        ...pluginContext,
        response,
      });
      await pluginRegistry.complete({
        ...pluginContext,
        response,
      });
    }

    if (bufferModelResponse && !reply.raw.destroyed) {
      childStream.flushAll();
      appaReceipts?.markReleased(bufferedOutcome.decision);
    }

    // Stream end events
    await finalizeInteraction();
    writeToClient(streamAdapter.formatEndSSE());
    reply.raw.end();

    streamCompleted = true;
    return reply;
  } catch (error) {
    const lifecycleError = error;
    const codexError =
      error instanceof CodexResponsesGenerationError ? error : undefined;
    if (codexError) {
      // The terminal status and its reason are not on the chat completion type.
      const outcome = asRecord(codexError.completion);
      logger.warn(
        {
          status: outcome?.status,
          incompleteReason: asRecord(outcome?.incomplete_details)?.reason,
          errorCode: asRecord(outcome?.error)?.code,
          errorMessage: asRecord(outcome?.error)?.message,
          usagePresent: codexError.completion.usage !== undefined,
          usage: codexError.completion.usage,
        },
        "Codex subscription response ended without completing",
      );
      // Translation keeps partial text and usage, but is not a successful turn.
      failedStreamResponse = codexError.completion;
      streamAdapter.state.usage = provider
        .createResponseAdapter(codexError.completion as TResponse, request)
        .getUsage();
      streamAdapter.state.toolCalls = [];
      streamAdapter.state.rawToolCallEvents = [];
      streamAdapter.state.stopReason = codexError.isIncompleteTerminal
        ? codexError.completion.choices[0].finish_reason
        : "error";
    }
    const eofError =
      error instanceof ResponsesStreamIncompleteError &&
      provider.provider === "openai" &&
      provider.interactionType === "openai:responses"
        ? error
        : undefined;
    if (eofError) {
      // Discard held executable fragments without emitting a synthetic success.
      streamAdapter.formatToolCallsSSE?.([]);
      streamAdapter.state.toolCalls = [];
      streamAdapter.state.rawToolCallEvents = [];
      streamAdapter.state.stopReason = "error";
      const observed = asRecord(
        discardUnadmittedResponsesOutput(
          streamAdapter.toProviderResponse() as Parameters<
            typeof discardUnadmittedResponsesOutput
          >[0],
        ),
      );
      // Construct from a safe subset of inert envelope fields only: a blind
      // spread of the observed provider response could carry executable-
      // capable fields (tool_calls, function_call items) into the recorded
      // failure.
      failedStreamResponse = {
        id: streamAdapter.state.responseId || `proxy_resp_${Date.now()}`,
        object: "response",
        ...(observed?.created_at !== undefined
          ? { created_at: observed.created_at }
          : {}),
        model: streamAdapter.state.model || actualModel,
        status: "incomplete",
        incomplete_details: null,
        error: { code: eofError.code, message: eofError.message },
        output: Array.isArray(observed?.output)
          ? observed.output.filter(
              (item) =>
                asRecord(item)?.type !== "function_call" &&
                asRecord(item)?.type !== "custom_tool_call",
            )
          : [],
        usage: observed?.usage ?? null,
      };
    }
    try {
      if (pluginRegistry && pluginContext) {
        await pluginRegistry.fail({ ...pluginContext, error });
      }
    } catch (pluginError) {
      logger.warn(
        { err: pluginError },
        "Plugin cleanup failed while handling proxy error",
      );
    }
    if (codexError?.isIncompleteTerminal) {
      // Preserve Chat's legal partial terminal only after failure cleanup.
      childStream.dropModel();
      const terminal = streamAdapter.processChunk({
        id: codexError.completion.id,
        object: "chat.completion.chunk",
        created: codexError.completion.created,
        model: codexError.completion.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: codexError.completion.choices[0].finish_reason,
          },
        ],
        usage: codexError.completion.usage,
      } as TChunk);
      if (terminal.sseData) writeToClient(terminal.sseData);
      await finalizeInteraction();
      writeToClient(streamAdapter.formatEndSSE());
      reply.raw.end();
      streamCompleted = true;
      return reply;
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
        extractDurationStatusCode(lifecycleError),
        source,
      );
      requestDurationRecorded = true;
    }

    // A stream that fails before any usage arrives (e.g. a provider 400
    // rejecting the request, or a mid-stream failure once SSE headers and
    // content are already on the wire) still has to reach interaction history.
    if (!streamAdapter.state.usage) {
      const errorMessage = upstreamErrorMessage(
        lifecycleError,
        provider.extractErrorMessage,
      );
      // Provider errors routinely echo the prompt back.
      logger.info(
        { profileId: agent.id, ...(suppressContent ? {} : { errorMessage }) },
        "Persisting error interaction record for failed stream",
      );
      await recordUsagelessInteraction(
        failedStreamResponse ?? { error: errorMessage },
      );
    }

    let streamError = lifecycleError;
    try {
      await finalizeInteraction();
    } catch (settlementError) {
      // Serialize settlement failure here too, while the SSE stream is open.
      logger.error(
        {
          upstreamStatus: extractDurationStatusCode(lifecycleError),
          ...(suppressContent ? {} : { err: lifecycleError }),
        },
        "Stream failure preceded usage settlement failure",
      );
      streamError = settlementError;
    }
    if (provider.binaryStream && reply.raw.headersSent) {
      reply.raw.destroy();
      return reply;
    }
    const formatStreamErrorFrame = provider.formatStreamErrorFrame;
    // Read once, here: nothing else writes to the client before the error
    // frame, so `terminalSent` cannot change after this point.
    const frameContext: StreamErrorFrameContext = {
      responseId:
        streamAdapter.clientResponse?.id ??
        (streamAdapter.state.responseId || undefined),
      model:
        streamAdapter.clientResponse?.model ??
        (streamAdapter.state.model || actualModel),
      terminalSent,
    };
    return handleError(
      streamError,
      reply,
      provider.extractErrorMessage,
      true,
      provider.extractInternalCode.bind(provider),
      formatStreamErrorFrame
        ? (event: unknown) => {
            const source = asRecord(event);
            return formatStreamErrorFrame(
              eofError
                ? {
                    ...source,
                    error: { ...asRecord(source?.error), code: eofError.code },
                  }
                : event,
              frameContext,
            );
          }
        : undefined,
      provider.translatesWireFormat,
    );
  } finally {
    keepAlive.stop();
    await finalizeInteraction();
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
    attributionLabels,
    agent,
    originalRequest,
    actualModel,
    enabledToolNames,
    toolIdentity,
    suppressContent,
    encryptedChat,
    appId,
    externalAgentId,
    authMethod,
    billingMode: initialBillingMode,
    getBillingMode,
    authenticatedApp,
    billingTeamId,
    userId,
    serviceAccountId,
    virtualKeyId,
    passthroughVirtualKeyId,
    resolvedUser,
    sessionId,
    sessionSource,
    source,
    runId,
    parentContext,
    teams,
    userTeams,
    streamTiming,
    pluginRegistry,
    pluginContext,
    appaReceipts,
  } = ctx;

  const providerName = provider.provider;
  const sendResponse = (response: unknown) => {
    if (ctx.connectionVerification) assertVerificationResponse(response);
    return reply.send(response);
  };
  let billingMode = initialBillingMode;
  const requestStartTime = Date.now();
  let codexGenerationError: CodexResponsesGenerationError | undefined;
  let tokenAccountingError: unknown;

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
    getPromptMessages: () =>
      provider.createRequestAdapter(originalRequest).getProviderMessages(),
    suppressContent,
    parentContext,
    user: toSpanUserInfo(resolvedUser),
    callback: async (llmSpan) => {
      // Record request duration for providers we instrument in the handler
      // (Bedrock). getObservableFetch covers the fetch-based providers, so those
      // must not double-report here — the flag gates that.
      let result: TResponse;
      try {
        if (pluginRegistry && pluginContext) {
          await pluginRegistry.onBeforeModel({ ...pluginContext, request });
        }
        if (reply.raw.destroyed)
          throw new ApiError(499, "Client disconnected before inference");
        await ctx.throughput?.admit(request);
        if (reply.raw.destroyed) {
          await ctx.throughput?.cancelBeforeSend();
          throw new ApiError(499, "Client disconnected before inference");
        }
        result = await openUpstream({
          ctx,
          transport: ownTransport(provider, client),
          open: async (transport) =>
            (await llmProxyTiming.upstream(reply, () =>
              transport.execute(request),
            )) as TResponse,
          memberTimeoutMs: poolResponseTimeoutMs(request),
          // See the streaming path: Gemini cannot safely classify this boundary.
          isRetryable: (error) =>
            providerName !== "gemini" &&
            isRetryableUpstreamConnectionFailure(error),
          shouldContinue: () => !reply.raw.destroyed,
          onRetry: (event) =>
            logUpstreamRetry({
              ...event,
              provider: providerName,
              model: actualModel,
            }),
        });
        if (ctx.connectionVerification) assertVerificationResponse(result);
        billingMode = getBillingMode();
      } catch (error) {
        if (error instanceof ObservedProviderUsageError) {
          try {
            await ctx.throughput?.reconcile(error.usage);
          } catch (accountingError) {
            // Preserve the provider failure and its billed interaction even
            // when recording the reported token usage also fails.
            logger.error(
              { err: accountingError },
              "Unable to record tokens from failed provider generation",
            );
          }
          const costs = await calculateInteractionCosts({
            actualModel: ctx.upstreamAttempt.modelId ?? actualModel,
            usage: error.usage,
            providerName: ctx.upstreamAttempt.provider ?? providerName,
            usageAccountingMode: ctx.usageAccountingMode,
            providerApiKeyId: ctx.providerApiKeyId,
          });
          const record = buildInteractionRecord({
            agent,
            billingAttribution: ctx.billingAttribution,
            externalAgentId,
            authMethod,
            billingMode: getBillingMode(),
            authenticatedApp,
            billingTeamId,
            runId,
            userId,
            serviceAccountId,
            virtualKeyId,
            passthroughVirtualKeyId,
            appId,
            sessionId,
            sessionSource,
            source,
            providerType: provider.interactionType,
            request: originalRequest,
            processedRequest: request,
            response: error.response,
            actualModel,
            usage: error.usage,
            costs,
          });
          await persistProxyInteraction({
            record,
            encryptedChat,
            streamTiming,
            attributionLabels,
            throughput: ctx.throughput,
            upstreamAttempt: ctx.upstreamAttempt,
          });
          if (costs.billingUsage?.mode === "enforce")
            withSessionContext(sessionId, () =>
              reportBillableUsageMetrics({
                usage: costs.billingUsage as PricedBillingUsage,
                agent,
                source,
                billingMode: getBillingMode(),
                authMethod,
                tokens: providerName === "anthropic",
              }),
            );
          throw new ObservedProviderUsageError({
            original: error.original,
            usage: error.usage,
            response: error.response,
            billingRecorded: true,
          });
        }
        if (error instanceof CodexResponsesGenerationError) {
          // Reuse accounting/persistence below without running success hooks.
          codexGenerationError = error;
          result = error.completion as TResponse;
          billingMode = getBillingMode();
        } else {
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
      }
      if (provider.recordRequestDurationInHandler) {
        metrics.llm.reportRequestDuration(
          providerName,
          agent,
          actualModel,
          (Date.now() - requestStartTime) / 1000,
          codexGenerationError && !codexGenerationError.isIncompleteTerminal
            ? extractDurationStatusCode(codexGenerationError)
            : "200",
          source,
        );
      }
      const adapter = provider.createResponseAdapter(result, request);
      try {
        await ctx.throughput?.reconcile(adapter.getUsage());
      } catch (error) {
        // Preserve interaction/spend accounting for the completed provider
        // call before reporting token-meter storage failure to the client.
        tokenAccountingError = error;
      }

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
      const cost = await calculateUsageCost({
        usageAccountingMode: ctx.usageAccountingMode,
        providerApiKeyId: ctx.providerApiKeyId,
        model: ctx.upstreamAttempt.modelId ?? actualModel,
        usage,
        provider: ctx.upstreamAttempt.provider ?? providerName,
      });
      if (cost !== undefined) {
        llmSpan.setAttribute(ATTR_ARCHESTRA_COST, cost);
        llmSpan.setAttribute(ATTR_ARCHESTRA_BILLING_MODE, billingMode);
      }
      llmSpan.setAttribute(
        ATTR_GENAI_RESPONSE_FINISH_REASONS,
        adapter.getFinishReasons(),
      );

      // Capture completion content (suppressed for encrypted chats)
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

  // Asked before failure cleanup ends the plugin session.
  const bufferModelResponse =
    pluginContext !== undefined &&
    pluginRegistry?.buffersModelResponse(pluginContext) === true;
  const generationFailed = await failResponsesGeneration({
    response: responseAdapter.getOriginalResponse(),
    ctx,
    error: codexGenerationError,
  });
  const hostedHold =
    !generationFailed && responseAdapter.withHeldHostedToolCalls
      ? await holdProxyPluginHostedToolCalls(
          ctx.pluginRegistry,
          ctx.pluginContext,
          responseAdapter.getHostedToolCalls?.() ?? [],
        )
      : null;
  for (const blocked of hostedHold?.blocked ?? []) {
    recordBlockedToolCallMetrics({
      allToolCallNames: [blocked.name],
      reason: blocked.reason,
      agent,
      teams,
      userTeams,
      sessionId,
      resolvedUser,
      providerName,
      toolCallCount: 1,
      actualModel,
      source,
    });
  }
  // A held turn's own calls rest on what was withheld, so they go with it.
  const toolCalls =
    generationFailed || hostedHold ? [] : responseAdapter.getToolCalls();
  logger.debug(
    { toolCallCount: toolCalls.length },
    `[${providerName}Proxy] Non-streaming response received, ruling on tool calls`,
  );

  // Let the proxy plugins rule on the response's tool calls
  let rewrittenToolCalls: AccumulatedToolCall[] | null = null;
  let blockedToolCalls: readonly { reason: string }[] =
    hostedHold?.blocked ?? [];
  if (toolCalls.length === 0) {
    await ctx.governedThread?.recordResponse({
      messageId: (responseAdapter.getOriginalResponse() as { id?: string }).id,
      providerCalls: [],
      clientCalls: [],
      refused: false,
      held: !!hostedHold,
    });
  }
  if (toolCalls.length > 0) {
    const emittedToolCalls = toolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments),
      // The namespace the model called the tool in, on a wire that has them.
      ...(toolCall.namespace ? { namespace: toolCall.namespace } : {}),
    }));
    rewrittenToolCalls = planDispatchRewrites({
      supported: responseAdapter.withRewrittenToolCalls !== undefined,
      toolCalls: emittedToolCalls,
      enabledToolNames,
      toolIdentity,
      providerName,
    });

    const policyOutcome = await evaluateProxyPluginToolCalls(
      ctx.pluginRegistry,
      ctx.pluginContext,
      rewrittenToolCalls ?? emittedToolCalls,
      responseAdapter.withRewrittenToolCalls !== undefined,
      responseAdapter.supportsToolCallReview === true &&
        typeof responseAdapter.withRewrittenToolCalls === "function",
    );
    if (policyOutcome.wasRewritten)
      rewrittenToolCalls = policyOutcome.toolCalls;
    const toolInvocationRefusal = policyOutcome.refusal;
    await ctx.governedThread?.recordResponse({
      messageId: (responseAdapter.getOriginalResponse() as { id?: string }).id,
      providerCalls: toolCalls,
      clientCalls: toolInvocationRefusal
        ? []
        : (rewrittenToolCalls ?? emittedToolCalls),
      refused: toolInvocationRefusal !== null,
      held: !!hostedHold,
    });
    // Record metrics for tool calls substituted with denial notices.
    blockedToolCalls = policyOutcome.blocked;
    for (const blocked of policyOutcome.blocked) {
      recordBlockedToolCallMetrics({
        allToolCallNames: [blocked.name],
        reason: blocked.reason,
        agent,
        teams,
        userTeams,
        sessionId,
        resolvedUser,
        providerName,
        toolCallCount: 1,
        actualModel,
        source,
      });
    }

    if (toolInvocationRefusal) {
      const { refusalMessage, contentMessage, reason, allToolCallNames } =
        toolInvocationRefusal;
      logger.debug(
        { toolCallCount: toolCalls.length },
        `[${providerName}Proxy] Tool invocation blocked by policy`,
      );

      let refusalResponse = responseAdapter.toRefusalResponse(
        refusalMessage,
        contentMessage,
      );
      if (
        pluginRegistry &&
        pluginContext &&
        pluginRegistry.buffersModelResponse(pluginContext)
      ) {
        const bufferedOutcome = await pluginRegistry.onBufferedModelResponse({
          ...pluginContext,
          response: refusalResponse,
          responseText: contentMessage,
        });
        if (bufferedOutcome.decision === "replace") {
          if (!responseAdapter.withReplacedText) {
            throw new ApiError(
              503,
              "LLM provider cannot safely replace a governed child response",
            );
          }
          refusalResponse = responseAdapter.withReplacedText(
            bufferedOutcome.responseText,
          );
        }
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

      // Record interaction with refusal (usage already corrected above)
      const costs = await calculateInteractionCosts({
        usageAccountingMode: ctx.usageAccountingMode,
        providerApiKeyId: ctx.providerApiKeyId,
        actualModel: ctx.upstreamAttempt.modelId ?? actualModel,
        usage,
        providerName: ctx.upstreamAttempt.provider ?? providerName,
      });

      withSessionContext(sessionId, () => {
        if (costs.billingUsage?.mode === "enforce") {
          reportBillableUsageMetrics({
            usage: costs.billingUsage,
            agent,
            source,
            billingMode,
            authMethod,
            tokens: providerName === "anthropic",
          });
          return;
        }
        if (providerName === "anthropic")
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
        billingAttribution: ctx.billingAttribution,
        agent,
        externalAgentId,
        authMethod,
        billingMode,
        authenticatedApp,
        billingTeamId,
        runId,
        userId,
        serviceAccountId,
        virtualKeyId,
        passthroughVirtualKeyId,
        appId,
        sessionId,
        sessionSource,
        source,
        providerType: provider.interactionType,
        request: originalRequest,
        processedRequest: request,
        response: responseAdapter.getLoggedResponse?.() ?? refusalResponse,
        actualModel,
        usage,
        costs,
        toolCallBlock: toToolCallBlock(toolInvocationRefusal, []),
      });
      await persistProxyInteraction({
        record: refusalRecord,
        encryptedChat,
        streamTiming,
        attributionLabels,
        throughput: ctx.throughput,
        upstreamAttempt: ctx.upstreamAttempt,
      });
      if (tokenAccountingError) {
        if (tokenAccountingError instanceof ThroughputError)
          tokenAccountingError.interactionRecorded = true;
        throw tokenAccountingError;
      }

      if (pluginRegistry && pluginContext) {
        // A refusal is a terminal answer: the turn ends here, as it does on
        // the streaming path, so the offers of this turn do not outlive it.
        await pluginRegistry.onModelResponse({
          ...pluginContext,
          response: refusalResponse,
        });
        await pluginRegistry.complete({
          ...pluginContext,
          response: refusalResponse,
        });
      }
      return sendResponse(refusalResponse);
    }
  }

  // Tool calls allowed (or no tool calls) - return response.
  // `usage` (corrected for zero-input above) is reused here.
  //
  // Computed once: a translator adapter that rewrites remembers the inner
  // (logged) shape it produced, so `getLoggedResponse` below must observe the
  // same call that produced the client response.
  const originalResponse = responseAdapter.getOriginalResponse();
  const failedResponse =
    generationFailed && !codexGenerationError
      ? asRecord(originalResponse)
      : null;
  const unobservedClientResponse = failedResponse
    ? (discardUnadmittedResponsesOutput(
        originalResponse as Parameters<
          typeof discardUnadmittedResponsesOutput
        >[0],
      ) as unknown as TResponse)
    : hostedHold && responseAdapter.withHeldHostedToolCalls
      ? responseAdapter.withHeldHostedToolCalls(hostedHold.notices)
      : rewrittenToolCalls && responseAdapter.withRewrittenToolCalls
        ? responseAdapter.withRewrittenToolCalls(rewrittenToolCalls)
        : originalResponse;
  let clientResponse = unobservedClientResponse;
  if (
    !generationFailed &&
    pluginRegistry &&
    pluginContext &&
    pluginRegistry.buffersModelResponse(pluginContext)
  ) {
    const bufferedOutcome = await pluginRegistry.onBufferedModelResponse({
      ...pluginContext,
      response: clientResponse,
      responseText: stripChildTrajectoryReceipts(responseAdapter.getText())
        .text,
    });
    if (bufferedOutcome.decision === "replace") {
      if (!responseAdapter.withReplacedText) {
        throw new ApiError(
          503,
          "LLM provider cannot safely replace a governed child response",
        );
      }
      clientResponse = responseAdapter.withReplacedText(
        bufferedOutcome.responseText,
      );
    }
  }
  if (!generationFailed && pluginRegistry && pluginContext) {
    const pluginResponse = await pluginRegistry.onModelResponse({
      ...pluginContext,
      response: clientResponse,
    });
    // The registry intentionally permits generic transformations. At the HTTP
    // boundary, provider wire responses must be objects, but are not schema-validated here.
    if (
      typeof pluginResponse !== "object" ||
      pluginResponse === null ||
      Array.isArray(pluginResponse)
    ) {
      throw new ApiError(500, "LLM proxy plugin returned an invalid response");
    }
    clientResponse = pluginResponse as TResponse;
  }
  // Anthropic tokens are emitted here for JSON and internally streamed calls;
  // its HTTP wrapper records duration only. Other providers own HTTP tokens.
  const costs = await calculateInteractionCosts({
    usageAccountingMode: ctx.usageAccountingMode,
    providerApiKeyId: ctx.providerApiKeyId,
    actualModel: ctx.upstreamAttempt.modelId ?? actualModel,
    usage,
    providerName: ctx.upstreamAttempt.provider ?? providerName,
  });

  withSessionContext(sessionId, () => {
    if (costs.billingUsage?.mode === "enforce") {
      reportBillableUsageMetrics({
        usage: costs.billingUsage,
        agent,
        source,
        billingMode,
        authMethod,
        tokens: providerName === "anthropic",
      });
      return;
    }
    if (providerName === "anthropic")
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

  let responsePersisted = false;
  try {
    const record = buildInteractionRecord({
      billingAttribution: ctx.billingAttribution,
      agent,
      externalAgentId,
      authMethod,
      billingMode,
      authenticatedApp,
      billingTeamId,
      runId,
      userId,
      serviceAccountId,
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
      // Either way under the provider's call ids, as the requests are logged.
      response: withProviderToolCallIds(
        generationFailed
          ? clientResponse
          : (responseAdapter.getLoggedResponse?.() ?? clientResponse),
        [...(rewrittenToolCalls ?? []), ...(hostedHold?.notices ?? [])],
      ),
      actualModel,
      usage,
      costs,
      toolCallBlock: toToolCallBlock(null, blockedToolCalls),
    });
    await persistProxyInteraction({
      record,
      encryptedChat,
      streamTiming,
      attributionLabels,
      throughput: ctx.throughput,
      upstreamAttempt: ctx.upstreamAttempt,
    });
    responsePersisted = true;
  } catch (interactionError) {
    logger.error(
      { err: interactionError, profileId: agent.id },
      "Failed to create interaction record (agent may have been deleted)",
    );
    if (ctx.usageAccountingMode === "enforce")
      throw new ApiError(503, "Unable to settle LLM usage");
  }
  if (tokenAccountingError) {
    if (tokenAccountingError instanceof ThroughputError)
      tokenAccountingError.interactionRecorded = responsePersisted;
    throw tokenAccountingError;
  }

  if (generationFailed) {
    if (codexGenerationError && !codexGenerationError.isIncompleteTerminal) {
      throw responsePersisted
        ? new RecordedCodexGenerationFailure(codexGenerationError)
        : codexGenerationError;
    }
    return sendResponse(
      bufferModelResponse
        ? withoutUnadmittedModelOutput(clientResponse)
        : clientResponse,
    );
  }
  if (pluginRegistry && pluginContext) {
    await pluginRegistry.complete({
      ...pluginContext,
      response: clientResponse,
    });
  }
  return sendResponse(
    appaReceipts
      ? appaReceipts.decorateResponse(clientResponse)
      : clientResponse,
  );
}

class RecordedCodexGenerationFailure extends ApiError {
  constructor(error: CodexResponsesGenerationError) {
    super(502, error.message);
  }
}

/** The client copy of a buffered generation that failed before admission. */
function withoutUnadmittedModelOutput<TResponse>(
  response: TResponse,
): TResponse {
  const record = asRecord(response);
  switch (record?.object) {
    case "response":
      return withoutResponsesModelOutput(
        response as Parameters<typeof withoutResponsesModelOutput>[0],
      ) as TResponse;
    case "chat.completion":
      return {
        ...record,
        choices: (Array.isArray(record.choices) ? record.choices : []).map(
          (choice) => {
            const entry = asRecord(choice);
            // Keeps only the role: content, refusal and reasoning all carry model text.
            return {
              ...entry,
              message: {
                role: asRecord(entry?.message)?.role ?? "assistant",
                content: "",
              },
            };
          },
        ),
      } as TResponse;
    default:
      throw new ApiError(
        503,
        "LLM provider cannot safely withhold a failed governed child response",
      );
  }
}

/** A native terminal failure ends the HTTP response, not the governed turn. */
async function failResponsesGeneration(params: {
  response: unknown;
  ctx: Pick<LLMProxyContext<unknown>, "pluginRegistry" | "pluginContext">;
  error?: Error;
}): Promise<boolean> {
  const response = asRecord(params.response);
  if (
    !params.error &&
    (response?.object !== "response" ||
      (response.status !== "incomplete" && response.status !== "failed"))
  ) {
    return false;
  }
  const details = asRecord(response?.error);
  const reason = asRecord(response?.incomplete_details)?.reason;
  const error =
    params.error ??
    new Error(
      typeof details?.message === "string"
        ? details.message
        : `Provider response ${response?.status}${
            typeof reason === "string" ? `: ${reason}` : ""
          }`,
    );
  const { pluginRegistry, pluginContext } = params.ctx;
  if (pluginRegistry && pluginContext) {
    try {
      await pluginRegistry.fail({ ...pluginContext, error });
    } catch (pluginError) {
      // Cleanup still runs in registry.fail's finally block. The native failure
      // remains the only client terminal, even if a plugin's error hook fails.
      logger.warn(
        { err: pluginError },
        "Plugin cleanup failed while handling provider terminal failure",
      );
    }
  }
  return true;
}

async function evaluateProxyPluginToolCalls(
  registry: LlmProxyPluginRegistry | undefined,
  context: LlmProxyRequestContext | undefined,
  toolCalls: readonly AccumulatedToolCall[],
  /** Whether this transport re-emits the calls the plugins return. */
  canRewriteToolCalls: boolean,
  /** Whether this transport emits a call's review details before the call. */
  canShowToolCallReview: boolean,
): Promise<{
  refusal: LlmProxyToolCallRefusal | null;
  toolCalls: AccumulatedToolCall[];
  wasRewritten: boolean;
  blocked: readonly { name: string; reason: string }[];
}> {
  if (!registry || !context)
    return {
      refusal: null,
      toolCalls: [...toolCalls],
      wasRewritten: false,
      blocked: [],
    };
  // Capture argument values before plugins run, not mutable object references.
  const originalCalls = toolCalls.map((call) => ({
    ...call,
    arguments:
      typeof call.arguments === "string"
        ? call.arguments
        : JSON.stringify(call.arguments),
  }));
  const outcome = await registry.onToolCalls({
    ...context,
    toolCalls,
    canRewriteToolCalls,
    canShowToolCallReview,
  });
  if (outcome.decision === "allow") {
    const releasedCalls = outcome.toolCalls.map((toolCall) => ({
      ...toolCall,
      arguments:
        typeof toolCall.arguments === "string"
          ? toolCall.arguments
          : JSON.stringify(toolCall.arguments),
    }));
    return {
      refusal: null,
      toolCalls: releasedCalls,
      wasRewritten:
        releasedCalls.length !== originalCalls.length ||
        releasedCalls.some((call, index) => {
          const original = originalCalls[index];
          return (
            call.id !== original.id ||
            call.wireId !== original.wireId ||
            call.name !== original.name ||
            call.namespace !== original.namespace ||
            call.arguments !== original.arguments ||
            call.reviewDetails !== original.reviewDetails
          );
        }),
      blocked: outcome.blocked ?? [],
    };
  }

  return {
    refusal: outcome.refusal,
    toolCalls: [...toolCalls],
    wasRewritten: false,
    blocked: [],
  };
}

/**
 * The notices that stand in for the provider-run part of a turn, or null when
 * that part is the client's to have. Runs before the turn's own calls are
 * checked: what a hosted call brought in is ruled on first.
 */
async function holdProxyPluginHostedToolCalls(
  registry: LlmProxyPluginRegistry | undefined,
  context: LlmProxyRequestContext | undefined,
  hostedToolCalls: readonly HostedToolCall[],
): Promise<{
  notices: AccumulatedToolCall[];
  blocked: readonly { name: string; reason: string }[];
} | null> {
  if (!registry || !context || hostedToolCalls.length === 0) return null;
  const outcome = await registry.onHostedToolCalls({
    ...context,
    hostedToolCalls,
  });
  if (outcome.decision === "release") return null;
  return {
    notices: outcome.notices.map((notice) => ({
      id: notice.id,
      name: notice.name,
      // The notice call includes the namespace where the tool was declared.
      // Codex requires this namespace to avoid an "unsupported call" error.
      ...(notice.namespace ? { namespace: notice.namespace } : {}),
      arguments:
        typeof notice.arguments === "string"
          ? notice.arguments
          : JSON.stringify(notice.arguments),
      // Codex dispatches a notice by the namespace its tool is declared in,
      // and the client is given the id the plugin chose for it.
      ...(notice.namespace ? { namespace: notice.namespace } : {}),
      ...(notice.wireId ? { wireId: notice.wireId } : {}),
    })),
    blocked: outcome.blocked,
  };
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
  toolIdentity: Pick<
    utils.gatewayToolNames.GatewayToolIdentity,
    "canonicalize" | "spellingOf" | "attestationOf"
  >;
  providerName: string;
}): AccumulatedToolCall[] | null {
  if (!params.supported) {
    return null;
  }

  const rewritten = planDispatchModeToolCallRewrites({
    toolCalls: params.toolCalls,
    enabledToolNames: params.enabledToolNames,
    toolIdentity: params.toolIdentity,
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

/**
 * Opens the upstream call: on the request's own client, or across its model
 * pool's members when it has one. Either way, the provider key that answered
 * (or failed last) is left in `ctx.upstreamAttempt` and priced in
 * `ctx.providerApiKeyId`.
 */
async function openUpstream<TRequest, T>(params: {
  ctx: LLMProxyContext<TRequest>;
  transport: MemberTransport;
  open: (transport: MemberTransport) => Promise<T>;
  /** Moves past a silent pool member; see openThroughModelPool. */
  memberTimeoutMs?: number;
  isRetryable: (error: unknown) => boolean;
  shouldContinue: () => boolean;
  onRetry?: (event: {
    attempt: number;
    delayMs: number;
    error: unknown;
  }) => void;
}): Promise<T> {
  const { ctx, transport, open, memberTimeoutMs, ...retry } = params;
  const pool = ctx.modelPool;
  if (!pool) {
    return openUpstreamWithRetry({ open: () => open(transport), ...retry });
  }
  try {
    return await openThroughModelPool({
      plan: pool.plan,
      attempt: ctx.upstreamAttempt,
      transportFor: pool.transportFor,
      open,
      memberTimeoutMs,
      recordFailedAttempt: pool.recordFailedAttempt,
      ...retry,
    });
  } finally {
    ctx.providerApiKeyId = ctx.upstreamAttempt.providerApiKeyId;
    pool.setResponseHeaders(ctx.upstreamAttempt);
  }
}

/**
 * How long a pool member that isn't the last may take to answer a
 * non-streaming request: the floor, plus time for every output token the
 * request allows. A request with no output limit gets the most.
 */
function poolResponseTimeoutMs(request: unknown): number {
  const maxOutputTokens = requestedMaxOutputTokens(request);
  if (maxOutputTokens === undefined) return MODEL_POOL_MAX_RESPONSE_TIMEOUT_MS;
  return Math.min(
    MODEL_POOL_MAX_RESPONSE_TIMEOUT_MS,
    MODEL_POOL_RESPONSE_TIMEOUT_MS +
      maxOutputTokens * MODEL_POOL_MS_PER_OUTPUT_TOKEN,
  );
}

/** The request's own provider and client, as a transport. */
function ownTransport(
  provider: Pick<
    LLMProvider<unknown, unknown, unknown, unknown, unknown>,
    "execute" | "executeStream"
  >,
  client: unknown,
): MemberTransport {
  return {
    execute: (request) => provider.execute(client, request),
    executeStream: (request) => provider.executeStream(client, request),
  };
}

function logUpstreamRetry(params: {
  attempt: number;
  delayMs: number;
  provider: string;
  model: string;
}): void {
  const { attempt, delayMs, provider, model } = params;
  logger.warn(
    { attempt, delayMs, provider, model },
    "Retrying upstream connection before receiving model output",
  );
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
 * sites treat encrypted-chat identically.
 *
 * - `encrypt`: store the full record, keyed to the conversation's browser-held
 *   DEK (recoverable offline via that conversation's escrow record).
 * - `redact`: fail-closed — content is replaced with the redaction marker
 *   rather than risking a plaintext write or an unrecoverable one.
 * - `none`: ordinary write; at-rest rules apply.
 */
async function persistProxyInteraction({
  record,
  encryptedChat,
  streamTiming,
  attributionLabels,
  throughput,
  upstreamAttempt,
}: {
  record: InsertInteraction;
  encryptedChat: EncryptedChatAuditDisposition;
  streamTiming: StreamTiming;
  attributionLabels?: AttributionLabels;
  throughput?: LlmThroughput;
  upstreamAttempt?: UpstreamAttempt;
}): Promise<void> {
  // Snapshot before database work; streaming calls reach here after consumption,
  // so this includes the full stream rather than just time to its first byte.
  record = {
    ...record,
    attributionLabels,
    durationMs: Math.max(
      0,
      Date.now() -
        (upstreamAttempt?.startedAt ?? streamTiming.requestReceivedAt),
    ),
    // A pooled attempt records the member model it was sent as; the pool's
    // name stays the baseline the client asked for.
    model: upstreamAttempt?.modelId ?? record.model,
    providerApiKeyId: upstreamAttempt?.providerApiKeyId,
    modelPoolId: upstreamAttempt?.modelPoolId,
    attempt: upstreamAttempt?.attempt,
    attemptOutcome: upstreamAttempt?.attemptOutcome,
    failureReason: upstreamAttempt?.failureReason,
  };
  await InteractionModel.record(
    encryptedChat.kind === "redact"
      ? redactEncryptedChatInteraction(record)
      : record,
    encryptedChat.kind === "encrypt" ? encryptedChat.audit : null,
  );
  await throughput?.settleSpend(
    record.cost,
    record.billingMode === "subscription" ? "subscription" : "metered",
  );
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
  internalCall: boolean,
): Promise<string | undefined> {
  const raw = request.headers[APP_ID_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return undefined;
  }

  if (!internalCall) {
    logger.warn(
      { agentId: agent.id },
      "Ignoring app attribution header without internal proof",
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

/**
 * Read the encrypted chat key off the request. A malformed header is
 * treated as absent (the resolver then fails closed to redaction) rather than
 * failing the LLM call — the proxy's job is to serve the request; losing the
 * key costs audit fidelity, not the user's turn.
 */
function readEncryptedChatDek(request: FastifyRequest): Buffer | null {
  const raw = request.headers[ENCRYPTED_CHAT_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  try {
    return parseEncryptedChatDekHeader(value);
  } catch {
    return null;
  }
}

/**
 * The request's proxy state, served from the proxy configuration cache when
 * it is live. Budget usage is not part of it; limit checks read usage fresh.
 */
async function readProxyRequestState(
  params: Parameters<typeof ProxyRequestContextModel.readForProxy>[0],
): Promise<ProxyRequestState> {
  return configCache.read(`context:${JSON.stringify(params)}`, () =>
    ProxyRequestContextModel.readForProxy(params),
  );
}
