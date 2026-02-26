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
import { ARCHESTRA_TOKEN_PREFIX } from "@shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import config from "@/config";
import logger from "@/logging";
import {
  AgentTeamModel,
  InteractionModel,
  LimitValidationService,
  ModelModel,
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
  type LLMProvider,
  type LLMStreamAdapter,
  type ToolCompressionStats,
  type ToonSkipReason,
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
  externalAgentId?: string;
  userId?: string;
  resolvedUser?: { id: string; email: string; name: string } | null;
  sessionId?: string | null;
  sessionSource?: SessionSource;
  executionId?: string;
  parentContext?: Context;
  teamIds?: string[];
}

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

  // Extract W3C trace context (traceparent/tracestate) from incoming request headers.
  // When the chat route calls the LLM proxy via localhost, the traced fetch injects these
  // headers so the LLM span becomes a child of the chat parent span.
  // For external API calls (no traceparent header), this returns root context (unchanged behavior).
  const parentContext = propagation.extract(
    otelContext.active(),
    request.headers,
  );

  const requestAdapter = provider.createRequestAdapter(body);
  const streamAdapter = provider.createStreamAdapter();
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
  let wasJwksAuthenticated = false;
  let wasVirtualKeyResolved = false;

  // 1. Try JWKS auth if the agent has an external identity provider configured
  const jwksResult = await attemptJwksAuth(
    request,
    resolvedAgent,
    providerName,
  );
  if (jwksResult) {
    wasJwksAuthenticated = true;
    apiKey = jwksResult.apiKey;
    perKeyBaseUrl = jwksResult.baseUrl;
    if (jwksResult.userId) {
      userId = jwksResult.userId;
      resolvedUser = await UserModel.getById(userId);
    }
  }

  // 2. Extract API key from headers if not already resolved via JWKS
  if (!wasJwksAuthenticated) {
    apiKey = provider.extractApiKey(headers);
  }

  // 3. Resolve virtual API key (archestra_ prefixed)
  // Strip "Bearer " prefix if present — OpenAI's extractApiKey returns the full
  // Authorization header value (e.g. "Bearer archestra_xxx"), while other providers
  // return the raw key.
  const rawApiKey = apiKey?.replace(/^Bearer\s+/i, "") ?? undefined;
  if (!wasJwksAuthenticated && rawApiKey?.startsWith(ARCHESTRA_TOKEN_PREFIX)) {
    await virtualKeyRateLimiter.check(request.ip);
    try {
      const virtualResult = await validateVirtualApiKey(
        rawApiKey,
        providerName,
      );
      apiKey = virtualResult.apiKey;
      perKeyBaseUrl = virtualResult.baseUrl;
      wasVirtualKeyResolved = true;
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 401) {
        await virtualKeyRateLimiter.recordFailure(request.ip);
      }
      throw error;
    }
  }

  // 4. Enforce authentication for keyless providers on external requests
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
        globalToolPolicy,
      },
      `[${providerName}Proxy] Evaluating trusted data policies`,
    );

    const commonMessages = requestAdapter.getMessages();
    const { toolResultUpdates, contextIsTrusted } =
      await utils.trustedData.evaluateIfContextIsTrusted(
        commonMessages,
        resolvedAgentId,
        apiKey,
        providerName,
        resolvedAgent.considerContextUntrusted,
        globalToolPolicy,
        { teamIds, externalAgentId },
        // Streaming callbacks for dual LLM progress
        requestAdapter.isStreaming()
          ? () => {
              ensureStreamHeaders();
              reply.raw.write(
                streamAdapter.formatTextDeltaSSE(
                  "Analyzing with Dual LLM:\n\n",
                ),
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
      mockMode: config.benchmark.mockMode,
      agent: resolvedAgent,
      externalAgentId,
      defaultHeaders:
        Object.keys(headersToForward).length > 0 ? headersToForward : undefined,
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
      externalAgentId,
      userId,
      resolvedUser,
      sessionId,
      sessionSource,
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
    return handleError(
      error,
      reply,
      provider.extractErrorMessage,
      requestAdapter.isStreaming(),
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
    externalAgentId,
    userId,
    resolvedUser,
    sessionId,
    sessionSource,
    executionId,
    parentContext,
    teamIds,
  } = ctx;

  const providerName = provider.provider;
  const streamStartTime = Date.now();
  let firstChunkTime: number | undefined;
  let streamCompleted = false;

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
      serverAddress: provider.getBaseUrl(),
      promptMessages: provider
        .createRequestAdapter(originalRequest)
        .getProviderMessages(),
      parentContext,
      user: toSpanUserInfo(resolvedUser),
      callback: async (llmSpan) => {
        const stream = await provider.executeStream(client, request);

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
              externalAgentId,
            );
          }

          const result = streamAdapter.processChunk(chunk);

          // Stream non-tool-call data immediately
          if (result.sseData) {
            ensureStreamHeaders();
            reply.raw.write(result.sseData);
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

      // Stream refusal
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
        externalAgentId,
      });
    } else if (toolCalls.length > 0) {
      // Tool calls approved - stream raw events
      logger.info(
        { toolCallCount: toolCalls.length },
        "Tool calls allowed, streaming them now",
      );

      ensureStreamHeaders();
      const rawEvents = streamAdapter.getRawToolCallEvents();
      for (const event of rawEvents) {
        reply.raw.write(event);
      }
    }

    // Stream end events
    ensureStreamHeaders();
    reply.raw.write(streamAdapter.formatEndSSE());
    reply.raw.end();

    streamCompleted = true;
    return reply;
  } catch (error) {
    return handleError(error, reply, provider.extractErrorMessage, true);
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
    externalAgentId,
    userId,
    resolvedUser,
    sessionId,
    sessionSource,
    executionId,
    parentContext,
    teamIds,
  } = ctx;

  const providerName = provider.provider;

  logger.debug(
    { model: actualModel },
    `[${providerName}ProxyV2] Starting non-streaming request`,
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
        providerType: provider.interactionType,
        request: originalRequest,
        processedRequest: request,
        response: responseAdapter.getOriginalResponse(),
        actualModel,
        baselineModel,
        usage,
        costs,
        toonStats,
        toonSkipReason,
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
