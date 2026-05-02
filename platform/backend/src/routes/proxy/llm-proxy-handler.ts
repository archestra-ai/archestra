/**
 * Generic LLM Proxy Handler
 *
 * A reusable handler that works with any LLM provider through the adapter pattern.
 * Routes choose which adapter factory to use based on URL.
 */

import {
  type Context,
  context as otelContext,
  propagation,
} from "@opentelemetry/api";
import {
  CHAT_API_KEY_ID_HEADER,
  hasArchestraTokenPrefix,
  type InteractionSource,
  InteractionSourceSchema,
  SOURCE_HEADER,
  UNTRUSTED_CONTEXT_HEADER,
} from "@shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import {
  AgentTeamModel,
  InteractionModel,
  LimitValidationService,
  LlmProviderApiKeyModel,
  ModelModel,
  ToolInvocationPolicyModel,
  UserModel,
} from "@/models";
import { metrics } from "@/observability";
import {
  ATTR_ARCHESTRA_COST,
  ATTR_GENAI_COMPLETION,
  ATTR_GENAI_RESPONSE_FINISH_REASONS,
  ATTR_GENAI_RESPONSE_ID,
  ATTR_GENAI_RESPONSE_MODEL,
  ATTR_GENAI_USAGE_INPUT_TOKENS,
  ATTR_GENAI_USAGE_OUTPUT_TOKENS,
  ATTR_GENAI_USAGE_TOTAL_TOKENS,
  EVENT_GENAI_CONTENT_COMPLETION,
} from "@/observability/tracing";
import {
  type Agent,
  ApiError,
  type DualLlmAnalysis,
  type InteractionRequest,
  type InteractionResponse,
  type LLMProvider,
  type LLMStreamAdapter,
  type ToolCompressionStats,
  type ToonSkipReason,
  UNSAFE_CONTEXT_BOUNDARY_REASON,
  type UnsafeContextBoundary,
} from "@/types";
import { isLoopbackAddress } from "@/utils/network";
import {
  assertAuthenticatedForKeylessProvider,
  attemptJwksAuth,
  resolveAgent,
  validateVirtualApiKey,
  virtualKeyRateLimiter,
} from "./llm-proxy-auth";
import {
  buildInteractionRecord,
  calculateInteractionCosts,
  handleError,
  normalizeToolCallsForPolicy,
  recordBlockedToolCallMetrics,
  toSpanUserInfo,
  withSessionContext,
} from "./llm-proxy-helpers";
import * as utils from "./utils";
import type { SessionSource } from "./utils/headers/session-id";

const {
  observability: {
    otel: { captureContent, contentMaxLength },
  },
} = config;

/**
 * Module-level LRU cache for per-tool blocking policy lookups.
 * Keyed by `${agentId}:${toolName}:${contextIsTrusted}` to scope per agent/trust context.
 * Shared across requests to avoid repeated DB queries for the same tool.
 */
const toolPolicyCache = new LRUCacheManager<boolean>({
  maxSize: 500,
  defaultTtl: 60_000, // 60 seconds
});

/**
 * Shared context passed to streaming and non-streaming handlers.
 * Groups the 15+ parameters that both handlers need into a single object
 * for maintainability and readability.
 */
export interface LLMProxyContext<TRequest> {
  agent: Agent;
  originalRequest: TRequest;
  baselineModel: string;
  actualModel: string;
  contextIsTrusted: boolean;
  enabledToolNames: Set<string>;
  globalToolPolicy: "permissive" | "restrictive";
  toonStats: ToolCompressionStats;
  toonSkipReason: ToonSkipReason | null;
  dualLlmAnalyses: DualLlmAnalysis[];
  unsafeContextBoundary?: UnsafeContextBoundary;
  externalAgentId?: string;
  userId?: string;
  resolvedUser?: { id: string; email: string; name: string } | null;
  sessionId?: string | null;
  sessionSource?: SessionSource;
  source: InteractionSource;
  executionId?: string;
  parentContext?: Context;
  teamIds?: string[];
}

export type LLMProxyAuthOverride = {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  /** Mapped chat_api_key row ID; used by the proxy to look up per-key settings (e.g. extra headers). */
  chatApiKeyId?: string;
  authenticated: boolean;
  source?: InteractionSource;
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
  const headers = request.headers as unknown as THeaders;
  const agentId = (request.params as { agentId?: string }).agentId;
  const providerName = provider.provider;

  // Extract header-based context
  const headersForExtraction = headers as Record<
    string,
    string | string[] | undefined
  >;
  const externalAgentId =
    utils.headers.externalAgentId.getExternalAgentId(headersForExtraction);
  const executionId =
    utils.headers.executionId.getExecutionId(headersForExtraction);
  const authOverride = (
    request as FastifyRequest & { llmProxyAuthOverride?: LLMProxyAuthOverride }
  ).llmProxyAuthOverride;
  let userId = (await utils.headers.userId.getUser(headersForExtraction))
    ?.userId;
  let resolvedUser = userId ? await UserModel.getById(userId) : null;

  const { sessionId, sessionSource } =
    utils.headers.sessionId.extractSessionInfo(
      headersForExtraction,
      body as
        | {
            metadata?: { user_id?: string | null };
            user?: string | null;
          }
        | undefined,
    );

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

  if (executionId) {
    const existsInDb = await InteractionModel.existsByExecutionId(executionId);
    if (!existsInDb) {
      logger.debug(
        { executionId, agentId: resolvedAgentId, externalAgentId },
        `[${providerName}Proxy] New execution detected, reporting metric`,
      );
      metrics.agentExecution.reportAgentExecution({
        executionId,
        profile: resolvedAgent,
        externalAgentId,
      });
    } else {
      logger.debug(
        { executionId, agentId: resolvedAgentId },
        `[${providerName}Proxy] Execution already exists in DB, skipping metric`,
      );
    }
  }

  // Authenticate and resolve API key (JWKS → virtual key → header extraction → keyless check)
  let apiKey: string | undefined;
  let perKeyBaseUrl: string | undefined;
  /**
   * The chat_api_key row ID for this call, if the call resolved through a
   * DB-managed key OR was forwarded by an internal loopback caller via
   * CHAT_API_KEY_ID_HEADER. Used at the bottom of the handler to look up
   * extra HTTP headers. `undefined` for raw-bearer calls from external IPs.
   */
  let perKeyChatApiKeyId: string | undefined;
  let wasJwksAuthenticated = false;
  let wasVirtualKeyResolved = false;
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
      apiKey = jwksResult.apiKey;
      perKeyBaseUrl = jwksResult.baseUrl;
      perKeyChatApiKeyId = jwksResult.chatApiKeyId;
      if (jwksResult.userId) {
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
  if (
    !wasJwksAuthenticated &&
    !authOverride &&
    rawApiKey &&
    hasArchestraTokenPrefix(rawApiKey)
  ) {
    await virtualKeyRateLimiter.check(request.ip);
    try {
      const virtualResult = await validateVirtualApiKey(
        rawApiKey,
        providerName,
      );
      apiKey = virtualResult.apiKey;
      perKeyBaseUrl = virtualResult.baseUrl;
      perKeyChatApiKeyId = virtualResult.chatApiKeyId;
      wasVirtualKeyResolved = true;
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 401) {
        await virtualKeyRateLimiter.recordFailure(request.ip);
      }
      throw error;
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
    if (isLoopbackAddress(request.ip)) {
      if (headerPresent) {
        perKeyChatApiKeyId = headerValue;
        logger.info(
          { chatApiKeyId: perKeyChatApiKeyId },
          `[${providerName}Proxy] received provider-api-key-id header`,
        );
      }
    } else if (headerPresent) {
      logger.warn(
        { ip: request.ip },
        `[${providerName}Proxy] ignoring provider-api-key-id header from non-loopback request`,
      );
    }
  }

  // 5. Enforce authentication for keyless providers on external requests
  assertAuthenticatedForKeylessProvider(
    apiKey,
    wasVirtualKeyResolved,
    wasJwksAuthenticated,
    request.ip,
  );

  // Check usage limits
  try {
    logger.debug(
      { resolvedAgentId },
      `[${providerName}Proxy] Checking usage limits`,
    );
    const limitViolation =
      await LimitValidationService.checkLimitsBeforeRequest(resolvedAgentId);

    if (limitViolation) {
      const [_refusalMessage, contentMessage] = limitViolation;
      logger.info(
        { resolvedAgentId, reason: "token_cost_limit_exceeded" },
        `${providerName} request blocked due to token cost limit`,
      );
      return reply.status(429).send({
        error: {
          message: contentMessage,
          type: "rate_limit_exceeded",
          code: "token_cost_limit_exceeded",
        },
      });
    }
    logger.debug(
      { resolvedAgentId },
      `[${providerName}Proxy] Limit check passed`,
    );

    // Persist tools declared by client (only for llm_proxy agents)
    if (resolvedAgent.agentType === "llm_proxy") {
      const tools = requestAdapter.getTools();
      if (tools.length > 0) {
        logger.debug(
          { toolCount: tools.length },
          `[${providerName}Proxy] Processing tools from request`,
        );
        await utils.tools.persistTools(
          tools.map((t) => ({
            toolName: t.name,
            toolParameters: t.inputSchema,
            toolDescription: t.description,
          })),
          resolvedAgentId,
        );
      }
    }

    // Cost optimization - potentially switch to cheaper model
    const baselineModel = requestAdapter.getModel();
    const hasTools = requestAdapter.hasTools();
    const tools = requestAdapter.getTools();
    // Cast messages since getOptimizedModel expects specific provider types
    // but our generic adapter provides the correct type at runtime
    const optimizedModel = await utils.costOptimization.getOptimizedModel(
      resolvedAgent,
      requestAdapter.getProviderMessages() as Parameters<
        typeof utils.costOptimization.getOptimizedModel
      >[1],
      providerName as Parameters<
        typeof utils.costOptimization.getOptimizedModel
      >[2],
      hasTools,
      tools,
    );

    if (optimizedModel) {
      requestAdapter.setModel(optimizedModel);
      logger.info(
        { resolvedAgentId, optimizedModel },
        "Optimized model selected",
      );
    } else {
      logger.info(
        { resolvedAgentId, baselineModel },
        "No matching optimized model found, proceeding with baseline model",
      );
    }

    const actualModel = requestAdapter.getModel();

    // Ensure model entries exist for cost tracking
    await ModelModel.ensureModelExists(baselineModel, providerName);

    if (actualModel !== baselineModel) {
      await ModelModel.ensureModelExists(actualModel, providerName);
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
      }
    };

    // Get global tool policy from organization (with fallback) - needed for both trusted data and tool invocation
    const globalToolPolicy =
      await utils.toolInvocation.getGlobalToolPolicy(resolvedAgentId);

    // Fetch team IDs for policy evaluation context (needed for trusted data evaluation)
    const teamIds = await AgentTeamModel.getTeamsForAgent(resolvedAgentId);

    // Evaluate trusted data policies
    logger.debug(
      {
        resolvedAgentId,
        considerContextUntrusted: resolvedAgent.considerContextUntrusted,
        inheritedContextUntrusted,
        globalToolPolicy,
      },
      `[${providerName}Proxy] Evaluating trusted data policies`,
    );

    const commonMessages = requestAdapter.getMessages();
    const effectiveConsiderContextUntrusted =
      resolvedAgent.considerContextUntrusted || inheritedContextUntrusted;
    const initialUntrustedReason = resolvedAgent.considerContextUntrusted
      ? UNSAFE_CONTEXT_BOUNDARY_REASON.agentConfiguredUntrusted
      : inheritedContextUntrusted
        ? UNSAFE_CONTEXT_BOUNDARY_REASON.inheritedFromParent
        : undefined;
    const {
      toolResultUpdates,
      contextIsTrusted,
      dualLlmAnalyses,
      unsafeContextBoundary,
    } = await utils.trustedData.evaluateIfContextIsTrusted(
      commonMessages,
      resolvedAgentId,
      resolvedAgent.organizationId,
      userId,
      effectiveConsiderContextUntrusted,
      globalToolPolicy,
      { teamIds, externalAgentId },
      // Streaming callbacks for dual LLM progress
      requestAdapter.isStreaming()
        ? () => {
            ensureStreamHeaders();
            reply.raw.write(
              streamAdapter.formatTextDeltaSSE("Analyzing with Dual LLM:\n\n"),
            );
          }
        : undefined,
      requestAdapter.isStreaming()
        ? (progress: {
            question: string;
            options: string[];
            answer: string;
          }) => {
            const optionsText = progress.options
              .map((opt: string, idx: number) => `  ${idx}: ${opt}`)
              .join("\n");
            ensureStreamHeaders();
            reply.raw.write(
              streamAdapter.formatTextDeltaSSE(
                `Question: ${progress.question}\nOptions:\n${optionsText}\nAnswer: ${progress.answer}\n\n`,
              ),
            );
          }
        : undefined,
      initialUntrustedReason,
    );

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

    // Extract provider-specific headers to forward (e.g., anthropic-beta)
    // Type cast is necessary because this is a generic handler for multiple providers,
    // and only Anthropic has the anthropic-beta header in its type definition
    const headersToForward: Record<string, string> = {};
    const headersObj = headers as Record<string, unknown>;
    if (typeof headersObj["anthropic-beta"] === "string") {
      headersToForward["anthropic-beta"] = headersObj["anthropic-beta"];
    }

    // Per-key extra HTTP headers (e.g. RBAC headers required by Kubeflow-style
    // gateways). Looked up by chat_api_key ID — set whenever the call resolved
    // through a DB-managed key (auth override, JWKS, virtual key). Raw-bearer
    // calls have no chat_api_key row, so no extra headers.
    let perKeyExtraHeaders: Record<string, string> | null = null;
    if (perKeyChatApiKeyId) {
      const row = await LlmProviderApiKeyModel.findById(perKeyChatApiKeyId);
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

    // Read per-key base URL override from header, but ONLY from internal (localhost) requests.
    // External clients must NOT be able to set this header — it would be an SSRF vector
    // (attacker could redirect the proxy to arbitrary URLs like cloud metadata endpoints).
    const providerBaseUrlHeader =
      isLoopbackAddress(request.ip) &&
      typeof headersForExtraction["x-archestra-provider-base-url"] === "string"
        ? headersForExtraction["x-archestra-provider-base-url"]
        : undefined;
    const effectiveBaseUrl =
      perKeyBaseUrl || providerBaseUrlHeader || provider.getBaseUrl();

    // Create client with observability (each provider handles metrics internally)
    const client = provider.createClient(apiKey, {
      baseUrl: effectiveBaseUrl,
      agent: resolvedAgent,
      externalAgentId,
      source,
      defaultHeaders:
        Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
    });

    // Build final request
    const finalRequest = requestAdapter.toProviderRequest();

    // Extract enabled tool names for filtering in evaluatePolicies
    const enabledToolNames = new Set(
      requestAdapter
        .getTools()
        .map((t) => t.name)
        .filter(Boolean),
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
      agent: resolvedAgent,
      originalRequest: requestAdapter.getOriginalRequest(),
      baselineModel,
      actualModel,
      contextIsTrusted,
      enabledToolNames,
      globalToolPolicy,
      toonStats,
      toonSkipReason,
      dualLlmAnalyses,
      unsafeContextBoundary,
      externalAgentId,
      userId,
      resolvedUser,
      sessionId,
      sessionSource,
      source,
      executionId,
      parentContext,
      teamIds,
    };

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
    } else {
      return handleNonStreaming(client, finalRequest, reply, provider, ctx);
    }
  } catch (error) {
    // Persist failed interactions so they appear in LLM logs
    try {
      const errorMessage = provider.extractErrorMessage(error);
      logger.info(
        { profileId: resolvedAgent.id, errorMessage },
        "Persisting error interaction record",
      );
      await InteractionModel.create({
        profileId: resolvedAgent.id,
        externalAgentId,
        executionId,
        userId,
        sessionId,
        sessionSource,
        source,
        type: provider.interactionType,
        request: requestAdapter.getOriginalRequest() as InteractionRequest,
        processedRequest: null,
        response: { error: errorMessage } as unknown as InteractionResponse,
        model: requestAdapter.getModel(),
        baselineModel: requestAdapter.getModel(),
        inputTokens: 0,
        outputTokens: 0,
      });
    } catch (interactionError) {
      logger.error(
        { err: interactionError, profileId: resolvedAgent.id },
        "Failed to create error interaction record",
      );
    }

    return handleError(
      error,
      reply,
      provider.extractErrorMessage,
      requestAdapter.isStreaming(),
      provider.extractInternalCode.bind(provider),
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
    baselineModel,
    actualModel,
    contextIsTrusted,
    enabledToolNames,
    globalToolPolicy,
    toonStats,
    toonSkipReason,
    dualLlmAnalyses,
    unsafeContextBoundary,
    externalAgentId,
    userId,
    resolvedUser,
    sessionId,
    sessionSource,
    source,
    executionId,
    parentContext,
    teamIds,
  } = ctx;

  const providerName = provider.provider;
  const streamStartTime = Date.now();
  let firstChunkTime: number | undefined;
  let streamCompleted = false;
  const streamedEventIndices = new Set<number>();
  // Once a blocking tool is encountered, buffer all subsequent tool call chunks
  // to prevent streaming data for tools that appear after a blocked tool.
  let bufferAllToolCalls = false;

  logger.debug(
    { model: actualModel },
    `[${providerName}Proxy] Starting streaming request`,
  );

  try {
    // Execute streaming request with tracing — the span covers the full streaming
    // operation (request → all chunks consumed) so we can set response attributes
    await utils.tracing.startActiveLlmSpan({
      operationName: provider.spanName,
      provider: providerName,
      model: actualModel,
      stream: true,
      agent,
      sessionId,
      executionId,
      externalAgentId,
      source,
      serverAddress: provider.getBaseUrl(),
      promptMessages: provider
        .createRequestAdapter(originalRequest)
        .getProviderMessages(),
      parentContext,
      user: toSpanUserInfo(resolvedUser),
      callback: async (llmSpan) => {
        const stream = await provider.executeStream(client, request);

        // Process chunks
        // Per-tool buffer/stream decisions: only "Allow always" tools stream immediately.
        // Policy lookups are cached in the module-level toolPolicyCache (LRU with TTL).

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
              externalAgentId,
            );
          }

          const result = streamAdapter.processChunk(chunk);

          // Stream text deltas immediately. For tool call chunks, check
          // the specific tool's policy to decide buffer vs stream:
          //  - "Allow always" tools: stream immediately for low latency
          //    (important for MCP Apps streaming UX).
          //  - Tools with blocking policies: buffer until policy evaluation
          //    completes so blocked call data is never exposed.
          if (result.sseData) {
            ensureStreamHeaders();
            reply.raw.write(result.sseData);
          } else if (result.isToolCallChunk) {
            // Determine if the current tool call should be streamed
            let shouldStream = globalToolPolicy === "permissive";
            if (!shouldStream && !bufferAllToolCalls) {
              const currentToolCall =
                streamAdapter.state.toolCalls[
                  streamAdapter.state.toolCalls.length - 1
                ];
              if (currentToolCall?.name) {
                const cacheKey = `${agent.id}:${currentToolCall.name}:${contextIsTrusted}`;
                let hasBlocking = toolPolicyCache.get(cacheKey);
                if (hasBlocking === undefined) {
                  try {
                    hasBlocking =
                      await ToolInvocationPolicyModel.hasBlockingPolicy(
                        currentToolCall.name,
                        contextIsTrusted,
                      );
                  } catch (err) {
                    logger.warn(
                      { err, toolName: currentToolCall.name },
                      "hasBlockingPolicy lookup failed, defaulting to buffer",
                    );
                    hasBlocking = true;
                  }
                  toolPolicyCache.set(cacheKey, hasBlocking);
                }
                if (hasBlocking) {
                  bufferAllToolCalls = true;
                }
                shouldStream = !hasBlocking;
              }
            }

            if (shouldStream) {
              const allEvents = streamAdapter.getRawToolCallEvents();
              ensureStreamHeaders();
              for (let i = 0; i < allEvents.length; i++) {
                if (!streamedEventIndices.has(i)) {
                  reply.raw.write(allEvents[i]);
                  streamedEventIndices.add(i);
                }
              }
            }
            // Buffered tools: events accumulate in
            // streamAdapter.state.rawToolCallEvents and are flushed
            // (or discarded) after policy evaluation below.
          }

          if (result.isFinal) {
            break;
          }
        }

        // Set response attributes on span per OTEL GenAI semconv
        const { state } = streamAdapter;
        if (state.model) {
          llmSpan.setAttribute(ATTR_GENAI_RESPONSE_MODEL, state.model);
        }
        if (state.responseId) {
          llmSpan.setAttribute(ATTR_GENAI_RESPONSE_ID, state.responseId);
        }
        if (state.usage) {
          llmSpan.setAttribute(
            ATTR_GENAI_USAGE_INPUT_TOKENS,
            state.usage.inputTokens,
          );
          llmSpan.setAttribute(
            ATTR_GENAI_USAGE_OUTPUT_TOKENS,
            state.usage.outputTokens,
          );
          llmSpan.setAttribute(
            ATTR_GENAI_USAGE_TOTAL_TOKENS,
            state.usage.inputTokens + state.usage.outputTokens,
          );
          const cost = await utils.costOptimization.calculateCost(
            actualModel,
            state.usage.inputTokens,
            state.usage.outputTokens,
            providerName,
          );
          if (cost !== undefined) {
            llmSpan.setAttribute(ATTR_ARCHESTRA_COST, cost);
          }
        }
        if (state.stopReason) {
          llmSpan.setAttribute(ATTR_GENAI_RESPONSE_FINISH_REASONS, [
            state.stopReason,
          ]);
        }

        // Capture streamed completion content
        if (captureContent && state.text) {
          llmSpan.addEvent(EVENT_GENAI_CONTENT_COMPLETION, {
            [ATTR_GENAI_COMPLETION]: state.text.slice(0, contentMaxLength),
          });
        }
      },
    });

    logger.info("Stream loop completed, processing final events");

    // Evaluate tool invocation policies
    const toolCalls = streamAdapter.state.toolCalls;
    let toolInvocationRefusal: utils.toolInvocation.PolicyBlockResult | null =
      null;

    if (toolCalls.length > 0) {
      logger.info(
        {
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map((tc) => tc.name),
        },
        "Evaluating tool invocation policies",
      );

      toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
        normalizeToolCallsForPolicy(toolCalls),
        agent.id,
        {
          teamIds: teamIds ?? [],
          externalAgentId,
        },
        contextIsTrusted,
        enabledToolNames,
        globalToolPolicy,
      );

      logger.info(
        { refused: !!toolInvocationRefusal },
        "Tool invocation policy result",
      );
    }

    if (toolInvocationRefusal) {
      const { contentMessage, reason, allToolCallNames } =
        toolInvocationRefusal;

      // When not buffering, tool call chunks were already streamed — append
      // refusal so clients know not to execute them. When buffering,
      // tool call chunks were held back and discarded — send only the refusal
      // so blocked tool call data is never exposed.
      ensureStreamHeaders();
      const refusalEvents = streamAdapter.formatCompleteTextSSE(contentMessage);
      for (const event of refusalEvents) {
        reply.raw.write(event);
      }

      recordBlockedToolCallMetrics({
        allToolCallNames,
        reason,
        agent,
        sessionId,
        resolvedUser,
        providerName,
        toolCallCount: toolCalls.length,
        actualModel,
        source,
        externalAgentId,
      });
    } else if (
      toolCalls.length > 0 &&
      streamedEventIndices.size < streamAdapter.getRawToolCallEvents().length
    ) {
      // Some tool call chunks were buffered during streaming (per-tool
      // blocking policies). Policy allowed them, so flush un-streamed events now.
      const allEvents = streamAdapter.getRawToolCallEvents();
      ensureStreamHeaders();
      for (let i = 0; i < allEvents.length; i++) {
        if (!streamedEventIndices.has(i)) {
          reply.raw.write(allEvents[i]);
        }
      }
    }

    // Stream end events
    ensureStreamHeaders();
    reply.raw.write(streamAdapter.formatEndSSE());
    reply.raw.end();

    streamCompleted = true;
    return reply;
  } catch (error) {
    return handleError(
      error,
      reply,
      provider.extractErrorMessage,
      true,
      provider.extractInternalCode.bind(provider),
    );
  } finally {
    // Always record interaction (whether stream completed or was aborted)
    if (!streamCompleted) {
      logger.info(
        "Stream was aborted before completion, recording partial interaction",
      );
    }

    const usage = streamAdapter.state.usage;
    if (usage) {
      withSessionContext(sessionId, () => {
        metrics.llm.reportLLMTokens(
          providerName,
          agent,
          { input: usage.inputTokens, output: usage.outputTokens },
          actualModel,
          source,
          externalAgentId,
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
            externalAgentId,
          );
        }
      });

      const costs = await calculateInteractionCosts({
        baselineModel,
        actualModel,
        usage,
        providerName,
      });

      withSessionContext(sessionId, () =>
        metrics.llm.reportLLMCost(
          providerName,
          agent,
          actualModel,
          costs.actualCost,
          source,
          externalAgentId,
        ),
      );

      try {
        await InteractionModel.create(
          buildInteractionRecord({
            agent,
            externalAgentId,
            executionId,
            userId,
            sessionId,
            sessionSource,
            source,
            providerType: provider.interactionType,
            request: originalRequest,
            processedRequest: request,
            response: streamAdapter.toProviderResponse(),
            actualModel,
            baselineModel,
            usage,
            costs,
            toonStats,
            toonSkipReason,
            dualLlmAnalyses,
            unsafeContextBoundary,
          }),
        );
      } catch (interactionError) {
        logger.error(
          { err: interactionError, profileId: agent.id },
          "Failed to create interaction record (agent may have been deleted)",
        );
      }
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
    baselineModel,
    actualModel,
    contextIsTrusted,
    enabledToolNames,
    globalToolPolicy,
    toonStats,
    toonSkipReason,
    dualLlmAnalyses,
    unsafeContextBoundary,
    externalAgentId,
    userId,
    resolvedUser,
    sessionId,
    sessionSource,
    source,
    executionId,
    parentContext,
    teamIds,
  } = ctx;

  const providerName = provider.provider;

  logger.debug(
    { model: actualModel },
    `[${providerName}Proxy] Starting non-streaming request`,
  );

  // Execute request with tracing
  const { responseAdapter } = await utils.tracing.startActiveLlmSpan({
    operationName: provider.spanName,
    provider: providerName,
    model: actualModel,
    stream: false,
    agent,
    sessionId,
    executionId,
    externalAgentId,
    source,
    serverAddress: provider.getBaseUrl(),
    promptMessages: provider
      .createRequestAdapter(originalRequest)
      .getProviderMessages(),
    parentContext,
    user: toSpanUserInfo(resolvedUser),
    callback: async (llmSpan) => {
      const result = await provider.execute(client, request);
      const adapter = provider.createResponseAdapter(result);

      // Set response attributes on span per OTEL GenAI semconv
      const usage = adapter.getUsage();
      llmSpan.setAttribute(ATTR_GENAI_RESPONSE_MODEL, adapter.getModel());
      llmSpan.setAttribute(ATTR_GENAI_RESPONSE_ID, adapter.getId());
      llmSpan.setAttribute(ATTR_GENAI_USAGE_INPUT_TOKENS, usage.inputTokens);
      llmSpan.setAttribute(ATTR_GENAI_USAGE_OUTPUT_TOKENS, usage.outputTokens);
      llmSpan.setAttribute(
        ATTR_GENAI_USAGE_TOTAL_TOKENS,
        usage.inputTokens + usage.outputTokens,
      );
      const cost = await utils.costOptimization.calculateCost(
        actualModel,
        usage.inputTokens,
        usage.outputTokens,
        providerName,
      );
      if (cost !== undefined) {
        llmSpan.setAttribute(ATTR_ARCHESTRA_COST, cost);
      }
      llmSpan.setAttribute(
        ATTR_GENAI_RESPONSE_FINISH_REASONS,
        adapter.getFinishReasons(),
      );

      // Capture completion content
      if (captureContent) {
        const text = adapter.getText?.();
        if (text) {
          llmSpan.addEvent(EVENT_GENAI_CONTENT_COMPLETION, {
            [ATTR_GENAI_COMPLETION]: text.slice(0, contentMaxLength),
          });
        }
      }

      return { response: result, responseAdapter: adapter };
    },
  });

  const toolCalls = responseAdapter.getToolCalls();
  logger.debug(
    { toolCallCount: toolCalls.length },
    `[${providerName}Proxy] Non-streaming response received, checking tool invocation policies`,
  );

  // Evaluate tool invocation policies
  if (toolCalls.length > 0) {
    const toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
      normalizeToolCallsForPolicy(toolCalls),
      agent.id,
      {
        teamIds: teamIds ?? [],
        externalAgentId,
      },
      contextIsTrusted,
      enabledToolNames,
      globalToolPolicy,
    );

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
        sessionId,
        resolvedUser,
        providerName,
        toolCallCount: toolCalls.length,
        actualModel,
        source,
        externalAgentId,
      });

      // Record interaction with refusal
      const usage = responseAdapter.getUsage();
      const costs = await calculateInteractionCosts({
        baselineModel,
        actualModel,
        usage,
        providerName,
      });

      withSessionContext(sessionId, () =>
        metrics.llm.reportLLMCost(
          providerName,
          agent,
          actualModel,
          costs.actualCost,
          source,
          externalAgentId,
        ),
      );

      await InteractionModel.create(
        buildInteractionRecord({
          agent,
          externalAgentId,
          executionId,
          userId,
          sessionId,
          sessionSource,
          source,
          providerType: provider.interactionType,
          request: originalRequest,
          processedRequest: request,
          response: refusalResponse,
          actualModel,
          baselineModel,
          usage,
          costs,
          toonStats,
          toonSkipReason,
          dualLlmAnalyses,
          unsafeContextBoundary,
        }),
      );

      return reply.send(refusalResponse);
    }
  }

  // Tool calls allowed (or no tool calls) - return response
  const usage = responseAdapter.getUsage();

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
  //   externalAgentId,
  // );

  const costs = await calculateInteractionCosts({
    baselineModel,
    actualModel,
    usage,
    providerName,
  });

  withSessionContext(sessionId, () =>
    metrics.llm.reportLLMCost(
      providerName,
      agent,
      actualModel,
      costs.actualCost,
      source,
      externalAgentId,
    ),
  );

  try {
    await InteractionModel.create(
      buildInteractionRecord({
        agent,
        externalAgentId,
        executionId,
        userId,
        sessionId,
        sessionSource,
        source,
        providerType: provider.interactionType,
        request: originalRequest,
        processedRequest: request,
        // Bedrock<->OpenAI compat need to return OpenAI response to client, but store bedrock response for interaction log.
        // Providers which need this behavior should implement getLoggedResponse() for persisting interaction and getOriginalResponse() for returning to client.
        response:
          responseAdapter.getLoggedResponse?.() ??
          responseAdapter.getOriginalResponse(),
        actualModel,
        baselineModel,
        usage,
        costs,
        toonStats,
        toonSkipReason,
        dualLlmAnalyses,
        unsafeContextBoundary,
      }),
    );
  } catch (interactionError) {
    logger.error(
      { err: interactionError, profileId: agent.id },
      "Failed to create interaction record (agent may have been deleted)",
    );
  }

  return reply.send(responseAdapter.getOriginalResponse());
}

function normalizeVirtualKeyCandidate(
  apiKey: string | undefined,
): string | undefined {
  if (!apiKey) {
    return undefined;
  }

  return apiKey.replace(/^Bearer[:\s]+/i, "");
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
