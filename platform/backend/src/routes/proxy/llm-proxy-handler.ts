import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
/**
 * Generic LLM Proxy Handler
 *
 * A reusable handler that works with any LLM provider through the adapter pattern.
 * Routes choose which adapter factory to use based on URL.
 */

import {
  APP_ID_HEADER,
  APPA_SESSION_HEADER,
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
  OPENCODE_AGENT_HEADER,
  OPENCODE_CLIENT_ID,
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
} from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";
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
  AppModel,
  ConversationModel,
  EnvironmentModel,
  InteractionModel,
  LimitValidationService,
  LlmProviderApiKeyModel,
  ModelModel,
  OpenAppaSessionModel,
  OrganizationModel,
  TeamModel,
  UserModel,
} from "@/models";
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
import { scopedSessionId } from "@/openappa/actor";
import { forkedSession } from "@/openappa/lineage";
import { prepareAppaRequest } from "@/openappa/request";
import {
  APPA_PARENT_HEADER,
  isAppaChatSource,
  isAppaDelegatedRun,
  isWellFormedAppaId,
  type OpenAppaSession,
  openappaEnabled,
  sessionFromHeaders,
} from "@/openappa/service";
import { formatSessionReceipt } from "@/openappa/session-token";
import { stampedSessions } from "@/openappa/trajectory-stamp";
import {
  type AppaSessionIdentity,
  appaWireFamily,
  appendSessionReceiptToResponse,
  restoreTrajectoryStamps,
  sessionReceiptEvidence,
  stripSessionReceiptsFromRequest,
} from "@/openappa/wire";
import { extractAppaSessionIdentity } from "@/proxy/plugins/appa-plugin-archestra/session-identity";
import {
  APPA_PLUGIN_TRUSTED_CONTEXT,
  type AppaTrustedContext,
} from "@/proxy/plugins/appa-plugin-archestra/types";
import {
  getLlmProxyPluginRegistry,
  type LlmProxyPluginRegistry,
  type LlmProxyRequestContext,
  type LlmProxyToolCallRefusal,
  type LlmProxyToolCallsContext,
} from "@/proxy/plugins/registry";
import { enrichDiscoveredModel } from "@/services/discovered-model-enrichment";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import {
  ApiError,
  DUAL_LLM_KEEPALIVE_SSE_COMMENT,
  type DualLlmAnalysis,
  type GatewayAgent,
  type HostedToolCall,
  type InsertInteraction,
  type InteractionAuthMethod,
  type InteractionRequest,
  type InteractionResponse,
  type LLMProvider,
  type LLMStreamAdapter,
  type OpenAiCodexPassthrough,
  type ToolCallBlock,
  type ToolInvocation,
  UNSAFE_CONTEXT_BOUNDARY_REASON,
  type UnsafeContextBoundary,
} from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";
import { repairLoneSurrogates } from "@/utils/lone-surrogates";
import { isLoopbackRequest } from "@/utils/network";
import { isUuid } from "@/utils/uuid";
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
  planDispatchModeToolCallRewrites,
  recordBlockedToolCallMetrics,
  shouldForwardAnthropicBeta,
  toolCallsForPolicyEvaluation,
  toSpanUserInfo,
  toToolCallBlock,
  withProviderToolCallIds,
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
  openappaSession?: OpenAppaSession;
  sessionReceipt?: SessionReceiptOutput;
  pluginRegistry?: LlmProxyPluginRegistry;
  pluginContext?: LlmProxyRequestContext;
  /** Captured by the host after binding an authenticated APPA session. */
  agent: GatewayAgent;
  originalRequest: TRequest;
  actualModel: string;
  contextIsTrusted: boolean;
  enabledToolNames: Set<string>;
  /** Which tool each client-presented name is, and whether the gateway attested it. */
  toolIdentity: utils.gatewayToolNames.GatewayToolIdentity;
  /**
   * The org's default invocation policy for a discovered tool, which rules a
   * call whose identity no tool row carries (see `toolCallsForPolicyEvaluation`).
   */
  discoveredToolInvocationDefault: ToolInvocation.ToolInvocationPolicyAction;
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
  /**
   * Client-visible latency clock. `requestReceivedAt` is stamped on entry to
   * the handler; `firstByteAt` is set by `ensureStreamHeaders` the moment the
   * response is committed — which, on a lazily committed stream, is also the
   * first byte the client sees, wherever in preflight or streaming it happens.
   */
  streamTiming: StreamTiming;
}

type SessionReceiptOutput = {
  family: NonNullable<ReturnType<typeof appaWireFamily>>;
  organizationId: string;
  sessionId: string;
  code: string;
  footer: string;
};

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
  if (
    provider.provider !== "openai" ||
    provider.interactionType !== "openai:responses" ||
    readSingleHeader(headers, "x-archestra-opencode-oauth-bridge") !== "true"
  ) {
    return undefined;
  }

  const authorization = readSingleHeader(headers, "authorization");
  const accessToken = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  const accountId = readSingleHeader(headers, "chatgpt-account-id");
  if (
    !accessToken ||
    accessToken.length > 16_384 ||
    !isBoundedHeaderValue(accountId, 256)
  ) {
    throw new ApiError(
      400,
      "OpenCode OAuth bridge requests require a bearer token and ChatGPT account ID.",
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
    throw new ApiError(400, `Invalid OpenCode OAuth bridge ${name} header.`);
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

function markSessionReceiptIssued(receipt: SessionReceiptOutput): void {
  trackBackgroundWork(
    OpenAppaSessionModel.markReceiptIssued({
      organizationId: receipt.organizationId,
      sessionId: receipt.sessionId,
    }).catch((error) => {
      logger.warn(
        { err: error, sessionId: receipt.sessionId },
        "OpenAPPA failed to record session receipt issuance",
      );
    }),
  );
}

/**
 * Detects Claude Code compaction summary requests. Claude Code puts the
 * instruction on a user turn (sometimes also in `system`); scan those text
 * sites only so a large tool result cannot trigger a false re-issue and so
 * the body is never serialized just to search it.
 */
function isClientCompactionRequest(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const request = body as Record<string, unknown>;
  if (containsCompactionInstruction(request.system)) return true;
  if (!Array.isArray(request.messages)) return false;
  for (const message of request.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const role = (message as Record<string, unknown>).role;
    if (role !== "user" && role !== "system") continue;
    if (
      containsCompactionInstruction(
        (message as Record<string, unknown>).content,
      )
    ) {
      return true;
    }
  }
  return false;
}

function containsCompactionInstruction(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes(CLAUDE_COMPACTION_INSTRUCTION);
  }
  if (!Array.isArray(value)) return false;
  for (const block of value) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const text = (block as Record<string, unknown>).text;
    if (
      typeof text === "string" &&
      text.includes(CLAUDE_COMPACTION_INSTRUCTION)
    ) {
      return true;
    }
  }
  return false;
}

const CLAUDE_COMPACTION_INSTRUCTION =
  "Your task is to create a detailed summary of the conversation so far";

/** Returns true if the request requires JSON-only structured output. */
function hasStructuredOutputConstraint(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const request = body as Record<string, unknown>;
  const format =
    request.response_format ??
    (request.text && typeof request.text === "object"
      ? (request.text as Record<string, unknown>).format
      : undefined) ??
    (request.output_config && typeof request.output_config === "object"
      ? (request.output_config as Record<string, unknown>).format
      : undefined) ??
    request.output_format;
  if (!format || typeof format !== "object" || Array.isArray(format)) {
    return false;
  }
  const type = (format as Record<string, unknown>).type;
  return type === "json_schema" || type === "json_object";
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
  const headers = request.headers as unknown as THeaders;
  const agentId = (request.params as { agentId?: string }).agentId;
  const providerName = provider.provider;
  const pluginRegistry = getLlmProxyPluginRegistry();
  const hasProxyPlugins = pluginRegistry.hasPlugins();
  let pluginContext: LlmProxyRequestContext | undefined;
  let pluginSessionInitialized = false;

  // Receipt stripping is unconditional: a transcript carrying marks must never
  // leak them to a provider or the logs, even with OpenAPPA off. APPA resolves
  // the collected codes into lineage evidence separately, when it is active.
  const requestWireFamily = appaWireFamily(provider.interactionType);
  const strippedReceiptCodes = requestWireFamily
    ? stripSessionReceiptsFromRequest({ family: requestWireFamily, body })
    : [];

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
  // identity headers; Cursor → "cursor" from its User-Agent).
  const externalAgentId =
    utils.headers.externalAgentId.getExternalAgentId(headersForExtraction) ??
    utils.headers.clientApp.detectClaudeClientId(bodyForExtraction) ??
    utils.headers.clientApp.detectCodexClientId(
      headersForExtraction,
      bodyForExtraction,
    ) ??
    utils.headers.clientApp.detectOpenCodeClientId(headersForExtraction) ??
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
  const openCodeSource: InteractionSource | undefined =
    externalAgentId === OPENCODE_CLIENT_ID
      ? openCodeParentSession
        ? "opencode:subagent"
        : openCodeAgent === "title"
          ? "opencode:title"
          : openCodeAgent === "compaction"
            ? "opencode:compaction"
            : "opencode:main"
      : undefined;
  const untrustedAppaChatSource =
    isAppaChatSource(parsedSource) && !isLoopbackRequest(request);
  // `model_router` is assigned by the route auth override, not accepted from
  // the public source header. APPA-capable Chat sources have the same
  // loopback-only trust boundary.
  const source: InteractionSource =
    authOverride?.source ??
    openCodeSource ??
    (parsedSource === "model_router" || untrustedAppaChatSource
      ? "api"
      : parsedSource) ??
    "api";

  // Session extraction reuses the resolved client attribution above to gate
  // OpenCode- and Codex-specific signals, so client identification lives in one place.
  // An external client's explicit OpenAPPA session names the runtime's root
  // for this request, under the credential's scope, and the proxy log follows
  // the id as the client sent it, so the two records join by that id under
  // the runtime's scope prefix. Chat's
  // header is its conversation id, which the ordinary path already records. Only while OpenAPPA is on: off, the header names nothing.
  // A malformed header is left to the OpenAPPA session check, which refuses it.
  const appaSessionHeader =
    openappaEnabled() && !isAppaChatSource(source)
      ? headersForExtraction[APPA_SESSION_HEADER.toLowerCase()]
      : undefined;
  const ordinarySession = utils.headers.sessionId.extractSessionInfo({
    headers: headersForExtraction,
    body: bodyForExtraction,
    externalAgentId,
  });
  // The platform's own requests carry the same id in both headers, and keep
  // their ordinary provenance; only a client that names its session in the
  // OpenAPPA header alone is followed there.
  const { sessionId, sessionSource } =
    isWellFormedAppaId(appaSessionHeader) &&
    ordinarySession.sessionId !== appaSessionHeader
      ? { sessionId: appaSessionHeader, sessionSource: "appa_header" as const }
      : ordinarySession;
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

  // Removes gateway tool attestation markers from the body in place
  // before adapters, logs, provider requests, or database records access them.
  const gatewayToolDeclarations =
    utils.gatewayToolDeclarations.extractGatewayToolDeclarations(body);
  // When OpenAPPA is enabled, the proxy issues stamped tool-call IDs.
  // The proxy restores original provider IDs before inspection, and uses
  // the stamps to trace source session lineage.
  const trajectoryStamps = restoreTrajectoryStamps({
    interactionType: provider.interactionType,
    body,
  });
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

  // OpenCode owns refresh and rotation for this access token. Keep the bridge
  // credential in request-local client options; never resolve or persist it as
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
    !openAiCodexPassthrough &&
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

  // Internal Chat requests arrive over loopback without platform credentials.
  // Requests that include organization credentials and name a Chat source
  // are treated as client requests. Their sessions scope to the credential
  // rather than a conversation.
  const isInternalChat =
    isAppaChatSource(source) &&
    isLoopbackRequest(request) &&
    !((authenticatedApp || virtualKeyId) && !authenticatedUserId);

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
  const appaActive = await isGuardrailsV2Active();
  if (appaActive && suppressContent) {
    throw new ApiError(
      409,
      "OpenAPPA does not yet support encrypted policy storage for locked chats",
    );
  }

  // Advisor consultations bill to the delegating caller's environment (the
  // advisor's own row is env-less). Resolved once so the limit check and every
  // interaction write agree on it.
  const delegationBillingEnvironmentId =
    await resolveDelegationBillingEnvironment(request, resolvedAgent);

  // App-runtime completions carry the calling app, so per-app runtime spend is
  // attributable instead of collapsing into the shared App Runtime agent.
  const attributedAppId = await resolveAttributedAppId(request, resolvedAgent);

  // Check usage limits
  try {
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

    // Internal Chat requests arrive over loopback without platform credentials.
    // Requests that include organization credentials and name a Chat source
    // are treated as client requests. Their sessions scope to the credential
    // rather than a conversation.
    const isInternalChat =
      isAppaChatSource(source) &&
      isLoopbackRequest(request) &&
      !((authenticatedApp || virtualKeyId) && !authenticatedUserId);

    // Identifies which declared tools the platform gateway served after
    // verifying attestations with the organization key.
    const toolIdentity =
      await utils.gatewayToolNames.resolveGatewayToolIdentity({
        organizationId: resolvedAgent.organizationId,
        declarations: gatewayToolDeclarations,
        internalChat: isInternalChat,
      });

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
        reply.raw.writeHead(200, sseHeaders);
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

    // Map client-decorated gateway tool names (such as Claude Code
    // `mcp__<label>__archestra__run_tool`) to platform canonical names
    // before guardrail evaluation. This ensures policy lookups evaluate
    // the actual tool instead of the client prefix or dispatch wrapper.
    const commonMessages = canonicalizeCommonMessageToolNames(
      requestAdapter.getMessages(),
      toolIdentity.canonicalize,
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

    const evaluateLegacyTrust = async () =>
      await utils.trustedData.evaluateIfContextIsTrusted({
        // The request body is mutable by the wire restorers below. Build this
        // just before analysis so signed transport footers reach no model.
        messages: canonicalizeCommonMessageToolNames(
          requestAdapter.getMessages(),
          toolIdentity.canonicalize,
        ),
        agentId: resolvedAgentId,
        organizationId: resolvedAgent.organizationId,
        userId,
        considerContextUntrusted: effectiveConsiderContextUntrusted,
        policyContext: { teamIds, externalAgentId },
        looseRunToolDispatch: toolIdentity.looseRunToolDispatch,
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
    let legacyTrustOutcome:
      | Awaited<ReturnType<typeof evaluateLegacyTrust>>
      | undefined;
    let pluginToolResultsOutcome:
      | Awaited<ReturnType<LlmProxyPluginRegistry["onToolResults"]>>
      | undefined;
    let openappaSession: OpenAppaSession | undefined;
    let sessionReceipt: SessionReceiptOutput | undefined;
    let appaIdentity: AppaSessionIdentity = {};
    let hasNativeClientSession = false;
    let appaCallerId: string | undefined;
    let appaFamily: ReturnType<typeof appaWireFamily>;
    let forkOf: string | undefined;
    if (hasProxyPlugins) {
      // APPA recognizes Chat only after the loopback caller's owner,
      // organization, profile, and conversation root have been bound below.
      // Internal agents (Chat, Slack, A2A, etc.) share the loopback boundary.
      // External clients still need platform authentication; a session ID or
      // user attribution header alone is not a credential.
      const isInternalRequest = isLoopbackRequest(request);
      if (
        appaActive &&
        !isInternalRequest &&
        !authenticatedUserId &&
        !authenticatedApp &&
        !virtualKeyId
      ) {
        throw new ApiError(
          401,
          "OpenAPPA requires an authenticated proxy request",
        );
      }
      // The person behind the request, when the platform authenticated one.
      // A platform request over loopback names its user in a header the
      // platform itself wrote; a request that brings a credential of its own
      // is a client's, and its user is what that credential proves, not what
      // a header says: over the frontend's loopback rewrite the header is
      // anyone's to write. Chat keeps the header: its conversation is
      // ownership-checked against it below.
      const appaUserId =
        authenticatedUserId ??
        (isInternalRequest &&
        (isInternalChat || (!authenticatedApp && !virtualKeyId))
          ? userId
          : undefined);
      // Delegated A2A runs share the parent's logging session, but have no
      // APPA child-return lifecycle. Keep their events out of that trajectory;
      // the existing guardrails still evaluate the child independently.
      // Only the trusted internal executor's agent chain selects this path.
      if (
        appaActive &&
        (!isInternalRequest ||
          !isAppaDelegatedRun(resolvedAgent.id, externalAgentId))
      ) {
        const callerId = appaUserId
          ? `user:${appaUserId}`
          : authenticatedApp
            ? `app:${authenticatedApp.id}`
            : virtualKeyId
              ? `virtual-key:${virtualKeyId}`
              : undefined;
        appaCallerId = callerId;
        // Extract client-native session metadata into APPA session identity.
        // Client adapters resolve resume, fork, and compaction semantics
        // before falling back to generic wire properties.
        const incomingAppaSessionHeader =
          headersForExtraction[APPA_SESSION_HEADER.toLowerCase()];
        appaFamily = appaWireFamily(provider.interactionType);
        appaIdentity = appaFamily
          ? extractAppaSessionIdentity({
              family: appaFamily,
              body,
              headers: headersForExtraction,
            })
          : {};
        hasNativeClientSession =
          appaIdentity.provenance === "claude-code-header" ||
          appaIdentity.provenance === "codex-turn-metadata" ||
          appaIdentity.provenance === "opencode-session-header" ||
          appaIdentity.provenance === "opencode-hosted-header";
        if (
          hasNativeClientSession &&
          appaIdentity.sessionId !== undefined &&
          !isWellFormedAppaId(appaIdentity.sessionId)
        ) {
          throw new ApiError(
            400,
            "OpenAPPA requires a valid client-native session ID",
          );
        }
        // Receipts were stripped from history above, before any forwarding or
        // logging. APPA now resolves the collected codes into lineage evidence
        // owned by this caller.
        const receiptSessions = callerId
          ? await sessionReceiptEvidence({
              organizationId: resolvedAgent.organizationId,
              callerId,
              codes: strippedReceiptCodes,
            })
          : [];
        // History carrying verified stamps or session receipts identifies
        // parent context. A new session opens as a fork of its deepest ancestor.
        const traceable =
          appaCallerId &&
          appaIdentity.sessionId &&
          appaFamily &&
          !isInternalChat &&
          !incomingAppaSessionHeader &&
          !headersForExtraction[APPA_PARENT_HEADER.toLowerCase()];
        const stamped =
          traceable && callerId
            ? stampedSessions({
                stamps: trajectoryStamps,
                organizationId: resolvedAgent.organizationId,
                callerId,
                secret: config.openappa.offerSigningSecret,
              })
            : [];
        // `forkedSession` identifies a single lineage head across stamps and text envelopes.
        const traced = traceable ? [...stamped, ...receiptSessions] : [];
        forkOf =
          traced.length > 0 && callerId && appaIdentity.sessionId
            ? await forkedSession({
                organizationId: resolvedAgent.organizationId,
                sessionId: appaIdentity.sessionId,
                traced,
                scope: (session) => scopedSessionId(callerId, session),
              })
            : undefined;
        if (
          appaIdentity.sessionId &&
          isWellFormedAppaId(appaIdentity.sessionId) &&
          !incomingAppaSessionHeader
        ) {
          headersForExtraction[APPA_SESSION_HEADER.toLowerCase()] =
            appaIdentity.sessionId;
        }
        if (
          appaIdentity.parentId &&
          isWellFormedAppaId(appaIdentity.parentId) &&
          !headersForExtraction[APPA_PARENT_HEADER.toLowerCase()]
        ) {
          headersForExtraction[APPA_PARENT_HEADER.toLowerCase()] =
            appaIdentity.parentId;
        }
        openappaSession = sessionFromHeaders({
          headers: headersForExtraction,
          organizationId: resolvedAgent.organizationId,
          callerId,
          // Chat sessions use conversation IDs with verified ownership.
          ...(isInternalChat
            ? {}
            : {
                // Scope external sessions to the authenticated principal.
                scope:
                  isInternalRequest &&
                  !authenticatedUserId &&
                  !authenticatedApp &&
                  !virtualKeyId &&
                  incomingAppaSessionHeader !== undefined
                    ? undefined
                    : callerId,
                // Bind fallback root if no session was provided.
                fallbackSessionId: callerId
                  ? `${callerId}@${resolvedAgent.id}`
                  : undefined,
              }),
        });
        if (!openappaSession)
          throw new ApiError(
            400,
            "OpenAPPA requires valid X-Appa-Session-ID and optional X-Appa-Parent-ID headers",
          );
        if (forkOf && callerId)
          openappaSession = {
            ...openappaSession,
            fork_of: scopedSessionId(callerId, forkOf),
          };
        if (
          callerId &&
          openappaSession.session_id === `${callerId}@${resolvedAgent.id}`
        ) {
          // Every conversation of this credential on this agent now shares one
          // root: a turn ending in one releases the offers of the others.
          logger.warn(
            { agentId: resolvedAgent.id, callerId },
            "OpenAPPA bound a fallback root because the client reported no session",
          );
        }
      }
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
      if (openappaSession) {
        // A Chat session is a conversation, and the request must name the
        // user whose conversation it is: without one there is nothing to
        // check the binding against, so the request is refused rather than
        // bound unchecked.
        if (isInternalChat && !appaUserId)
          throw new ApiError(
            403,
            "OpenAPPA Chat session requires the conversation's user",
          );
        if (isInternalChat && appaUserId) {
          const conversationAgentId = await ConversationModel.getAgentIdForUser(
            openappaSession.session_id,
            appaUserId,
            resolvedAgent.organizationId,
          );
          if (
            !conversationAgentId ||
            (source !== "chat:compaction" &&
              conversationAgentId !== resolvedAgent.id)
          ) {
            throw new ApiError(
              403,
              "OpenAPPA Chat session does not match the authenticated conversation",
            );
          }
        }
        // Restores this request's denial notices and resolves its APPA tools,
        // in the request body the adapters read from, before the provider
        // request and the tool results are built from it.
        // It refuses the request outright when the session cannot be governed,
        // so reaching the line below means APPA really is enforcing this turn.
        // The ordinary invocation policies still run: they are evaluated inside
        // the plugin pass, before APPA reserves a call.
        const appaRequest = prepareAppaRequest({
          body,
          interactionType: provider.interactionType,
          session: appaIdentity,
          identity: toolIdentity,
          trustBarePlatformTools: isInternalChat,
        });
        pluginContext.resources.set(APPA_PLUGIN_TRUSTED_CONTEXT, {
          session: openappaSession,
          profileId: resolvedAgent.id,
          toolIdentity,
          request: appaRequest,
          ...(isInternalChat ? { chatSource: source } : {}),
        } satisfies AppaTrustedContext);
      }
      await pluginRegistry.onSessionInit(pluginContext);
      pluginSessionInitialized = true;
      if (openappaSession) {
        legacyTrustOutcome = await evaluateLegacyTrust();
      }
      pluginToolResultsOutcome = await pluginRegistry.onToolResults({
        ...pluginContext,
        // Adapters can defer wire updates until serialization; pass the filtered
        // content explicitly so APPA cannot inspect a blocked/raw version.
        toolResults: requestAdapter.getToolResults().map((result) => ({
          ...result,
          content:
            legacyTrustOutcome?.toolResultUpdates[result.id] ?? result.content,
        })),
      });
      if (
        openappaSession &&
        hasNativeClientSession &&
        !isInternalChat &&
        !hasStructuredOutputConstraint(body) &&
        appaCallerId &&
        appaFamily &&
        config.openappa.offerSigningSecret.length > 0
      ) {
        const receipt = await OpenAppaSessionModel.ensureReceiptToken({
          organizationId: resolvedAgent.organizationId,
          callerId: appaCallerId,
          sessionId: openappaSession.session_id,
          secret: config.openappa.offerSigningSecret,
        });
        if (
          receipt &&
          (receipt.receiptIssuedAt == null || isClientCompactionRequest(body))
        ) {
          sessionReceipt = {
            family: appaFamily,
            organizationId: resolvedAgent.organizationId,
            sessionId: openappaSession.session_id,
            code: receipt.token,
            footer: formatSessionReceipt(receipt.token),
          };
        }
      }
    }
    const trustedDataOutcome =
      legacyTrustOutcome ??
      pluginToolResultsOutcome?.contextTrust ??
      (await evaluateLegacyTrust());
    const { contextIsTrusted, dualLlmAnalyses, unsafeContextBoundary } =
      trustedDataOutcome;
    const toolResultUpdates = {
      ...("toolResultUpdates" in trustedDataOutcome
        ? trustedDataOutcome.toolResultUpdates
        : {}),
      ...pluginToolResultsOutcome?.toolResultUpdates,
    };

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
        openAiCodexPassthrough !== undefined ||
        provider.isSubscriptionCredential?.(apiKey) === true,
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
      openAiCodexPassthrough,
      ...(providerName === "gemini" &&
      typeof headersForExtraction["x-goog-user-project"] === "string"
        ? { googleUserProject: headersForExtraction["x-goog-user-project"] }
        : {}),
    });

    if (pluginContext) {
      await pluginRegistry.onPrompt({
        ...pluginContext,
        prompt: requestAdapter.getProviderMessages(),
      });
    }

    // Build final request
    const builtRequest = requestAdapter.toProviderRequest();

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

    // Convert headers to Record<string, string> for policy evaluation context
    const headersRecord: Record<string, string> = {};
    const rawHeaders = headers as Record<string, unknown>;
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string") {
        headersRecord[key] = value;
      }
    }

    const ctx: LLMProxyContext<TRequest> = {
      openappaSession,
      ...(sessionReceipt ? { sessionReceipt } : {}),
      ...(pluginContext ? { pluginRegistry, pluginContext } : {}),
      agent: resolvedAgent,
      originalRequest: requestAdapter.getOriginalRequest(),
      actualModel,
      contextIsTrusted,
      enabledToolNames,
      toolIdentity,
      discoveredToolInvocationDefault:
        organization?.defaultDiscoveredToolInvocationPolicy ??
        "block_when_context_is_untrusted",
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
    // Persist failed interactions so they appear in LLM logs
    try {
      const errorMessage = provider.extractErrorMessage(lifecycleError);
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
      lifecycleError,
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
    toolIdentity,
    discoveredToolInvocationDefault,
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
    streamTiming,
    pluginRegistry,
    pluginContext,
    sessionReceipt,
  } = ctx;

  const providerName = provider.provider;
  if (pluginContext && pluginRegistry?.governsHostedToolCalls(pluginContext)) {
    streamAdapter.withholdHostedToolCalls?.();
  }
  if (sessionReceipt) {
    streamAdapter.setTextSuffix?.((text) => {
      if (text.length === 0) return "";
      markSessionReceiptIssued(sessionReceipt);
      return sessionReceipt.footer;
    });
  }
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
        if (pluginRegistry && pluginContext) {
          await pluginRegistry.onBeforeModel({ ...pluginContext, request });
        }
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
          // Whatever an adapter does put in `sseData` is forwarded verbatim,
          // so an adapter that emits a chunk carrying both text and a tool call
          // defeats this (gemini.ts, minimax.ts, and openai.ts's `delta.content`
          // branch still do; zhipuai.ts guards it), as does one whose terminal
          // frame echoes the turn's calls (the Responses adapters).
          if (result.sseData) {
            writeToClient(result.sseData);
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
      const heldEvents = streamAdapter.formatHeldHostedToolCallsSSE(
        hostedHold.notices,
      );
      if (!reply.raw.destroyed) {
        for (const event of heldEvents) {
          writeToClient(event);
        }
      }
    }

    // Evaluate tool invocation policies. A held turn's own calls rest on what
    // was withheld, so they went with it.
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
        "Evaluating tool invocation policies",
      );

      const policyOutcome = await evaluateProxyPluginToolCalls(
        ctx.pluginRegistry,
        ctx.pluginContext,
        rewrittenToolCalls ?? toolCalls,
        async (calls) =>
          await utils.toolInvocation.evaluatePolicies(
            toolCallsForPolicyEvaluation({
              toolCalls: [...calls],
              toolIdentity,
              discoveredToolDefault: discoveredToolInvocationDefault,
            }),
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
          ),
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
        "Tool invocation policy result",
      );

      toolCallBlock = toToolCallBlock(toolInvocationRefusal);
    }

    if (toolInvocationRefusal) {
      const { contentMessage, reason, allToolCallNames } =
        toolInvocationRefusal;

      // Drop the held tool-call events and use the existing refusal format.
      // Its text comes from APPA when enabled.
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
          writeToClient(event);
        }
      }
    }

    // The stream is already client-visible. This observes the assembled wire
    // response without pretending a plugin can rewrite bytes already sent.
    if (pluginRegistry && pluginContext) {
      const response = streamAdapter.toProviderResponse();
      await pluginRegistry.onModelResponse({
        ...pluginContext,
        response,
      });
      await pluginRegistry.complete({
        ...pluginContext,
        response,
      });
    }

    // Stream end events
    writeToClient(streamAdapter.formatEndSSE());
    reply.raw.end();

    streamCompleted = true;
    return reply;
  } catch (error) {
    const lifecycleError = error;
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
      const errorMessage = provider.extractErrorMessage(lifecycleError);
      logger.info(
        { profileId: agent.id, errorMessage },
        "Persisting error interaction record for failed stream",
      );
      await recordUsagelessInteraction({ error: errorMessage });
    }

    return handleError(
      lifecycleError,
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
          response: withProviderToolCallIds(
            streamAdapter.toProviderResponse(),
            streamAdapter.state.toolCalls,
          ),
          actualModel,
          usage,
          costs,
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
      await recordUsagelessInteraction(
        withProviderToolCallIds(
          streamAdapter.toProviderResponse(),
          streamAdapter.state.toolCalls,
        ),
      );
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
    toolIdentity,
    discoveredToolInvocationDefault,
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
    pluginRegistry,
    pluginContext,
    sessionReceipt,
  } = ctx;

  const providerName = provider.provider;
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
        if (pluginRegistry && pluginContext) {
          await pluginRegistry.onBeforeModel({ ...pluginContext, request });
        }
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

  const hostedHold = responseAdapter.withHeldHostedToolCalls
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
  const toolCalls = hostedHold ? [] : responseAdapter.getToolCalls();
  logger.debug(
    { toolCallCount: toolCalls.length },
    `[${providerName}Proxy] Non-streaming response received, checking tool invocation policies`,
  );

  // Evaluate tool invocation policies
  let rewrittenToolCalls: AccumulatedToolCall[] | null = null;
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
      async (calls) =>
        await utils.toolInvocation.evaluatePolicies(
          toolCallsForPolicyEvaluation({
            toolCalls: [...calls],
            toolIdentity,
            discoveredToolDefault: discoveredToolInvocationDefault,
          }),
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
        ),
    );
    if (policyOutcome.wasRewritten)
      rewrittenToolCalls = policyOutcome.toolCalls;
    const toolInvocationRefusal = policyOutcome.refusal;
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
        dualLlmAnalyses,
        unsafeContextBoundary,
        toolCallBlock: toToolCallBlock(toolInvocationRefusal),
      });
      await persistProxyInteraction(
        refusalRecord,
        lockedChat,
        delegationBillingEnvironmentId,
      );

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
      return reply.send(refusalResponse);
    }
  }

  // Tool calls allowed (or no tool calls) - return response.
  // `usage` (corrected for zero-input above) is reused here.
  //
  // Computed once: a translator adapter that rewrites remembers the inner
  // (logged) shape it produced, so `getLoggedResponse` below must observe the
  // same call that produced the client response.
  const unobservedClientResponse =
    hostedHold && responseAdapter.withHeldHostedToolCalls
      ? responseAdapter.withHeldHostedToolCalls(hostedHold.notices)
      : rewrittenToolCalls && responseAdapter.withRewrittenToolCalls
        ? responseAdapter.withRewrittenToolCalls(rewrittenToolCalls)
        : responseAdapter.getOriginalResponse();
  let clientResponse = unobservedClientResponse;
  if (pluginRegistry && pluginContext) {
    const pluginResponse = await pluginRegistry.onModelResponse({
      ...pluginContext,
      response: unobservedClientResponse,
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
      // Either way under the provider's call ids, as the requests are logged.
      response: withProviderToolCallIds(
        responseAdapter.getLoggedResponse?.() ?? clientResponse,
        [...(rewrittenToolCalls ?? []), ...(hostedHold?.notices ?? [])],
      ),
      actualModel,
      usage,
      costs,
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

  if (pluginRegistry && pluginContext) {
    await pluginRegistry.complete({
      ...pluginContext,
      response: clientResponse,
    });
  }
  if (!sessionReceipt) return reply.send(clientResponse);
  const outboundResponse = structuredClone(clientResponse);
  const appended = appendSessionReceiptToResponse({
    family: sessionReceipt.family,
    response: outboundResponse,
    code: sessionReceipt.code,
  });
  if (appended) markSessionReceiptIssued(sessionReceipt);
  return reply.send(outboundResponse);
}

async function evaluateProxyPluginToolCalls(
  registry: LlmProxyPluginRegistry | undefined,
  context: LlmProxyRequestContext | undefined,
  toolCalls: readonly AccumulatedToolCall[],
  validate: (
    calls: LlmProxyToolCallsContext["toolCalls"],
  ) => Promise<LlmProxyToolCallRefusal | null>,
): Promise<{
  refusal: LlmProxyToolCallRefusal | null;
  toolCalls: AccumulatedToolCall[];
  wasRewritten: boolean;
  blocked: readonly { name: string; reason: string }[];
}> {
  if (!registry || !context)
    return {
      refusal: await validate(toolCalls),
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
  const outcome = await registry.onToolCalls(
    { ...context, toolCalls },
    validate,
  );
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
            call.arguments !== original.arguments
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
