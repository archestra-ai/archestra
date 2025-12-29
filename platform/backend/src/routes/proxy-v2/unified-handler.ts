import type { SupportedProviderDiscriminator } from "@shared";
import type { FastifyReply } from "fastify";
import getDefaultPricing from "@/default-model-prices";
import {
  reportBlockedTools,
  reportLLMCost,
  reportLLMTokens,
} from "@/llm-metrics";
import logger from "@/logging";
import {
  AgentModel,
  InteractionModel,
  LimitValidationService,
  TokenPriceModel,
} from "@/models";
import type { Agent, OpenAi } from "@/types";
import * as adapters from "../proxy/utils/adapters";
import * as costOptimization from "../proxy/utils/cost-optimization";
import * as toolInvocation from "../proxy/utils/tool-invocation";
import * as tools from "../proxy/utils/tools";
import * as toonConversion from "../proxy/utils/toon-conversion";
import * as trustedData from "../proxy/utils/trusted-data";
import type { OpenAIStreamChunk } from "./base-transformer";
import type { Provider, ProxyContext } from "./provider";

// Re-export OpenAI types for convenience
type OpenAIRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAIResponse = OpenAi.Types.ChatCompletionsResponse;

/**
 * Callbacks for streaming dual LLM progress
 */
export interface DualLlmCallbacks {
  onDualLlmStart?: () => void;
  onDualLlmProgress?: (progress: {
    question: string;
    options: string[];
    answer: string;
  }) => void;
}

/**
 * Options for the unified request handler
 */
export interface HandleRequestOptions<TRequest, TResponse, TStreamEvent> {
  /** Provider instance for API calls and transformations */
  provider: Provider<TRequest, TResponse, TStreamEvent>;
  /** Raw request in provider format */
  request: TRequest;
  /** Fastify reply object */
  reply: FastifyReply;
  /** Agent ID from URL params (optional) */
  agentId?: string;
  /** User-Agent header for default agent resolution */
  userAgent?: string;
  /** API key from request headers */
  apiKey: string;
  /** External agent ID for metrics (optional) */
  externalAgentId?: string;
  /** User ID for interaction recording (optional) */
  userId?: string;
  /** Whether this is a streaming request */
  stream: boolean;
  /** Callbacks for streaming dual LLM progress */
  dualLlmCallbacks?: DualLlmCallbacks;
}

/**
 * Error thrown when usage limits are exceeded
 */
export class LimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitExceededError";
  }
}

/**
 * LLMProxy handler.
 *
 * @throws LimitExceededError if usage limits are exceeded
 * @throws Error if agent not found or API call fails
 */
export async function handleRequest<TRequest, TResponse, TStreamEvent>(
  options: HandleRequestOptions<TRequest, TResponse, TStreamEvent>,
): Promise<void> {
  const {
    provider,
    request,
    reply,
    agentId,
    userAgent,
    apiKey,
    externalAgentId,
    userId,
    stream,
    dualLlmCallbacks,
  } = options;

  const { transformer } = provider;

  // ========== 1. RESOLVE AGENT ==========
  logger.info(
    { agentId, userAgent },
    "LLMProxy.handleRequest: Resolving agent",
  );

  const agent = agentId
    ? await AgentModel.findById(agentId)
    : await AgentModel.getAgentOrCreateDefault(userAgent);

  if (!agent) {
    reply.status(404).send({
      error: {
        message: `Agent with ID ${agentId} not found`,
        type: "not_found",
      },
    });
    return;
  }

  logger.info(
    { agentId: agent.id, agentName: agent.name },
    "LLMProxy.handleRequest: Agent resolved",
  );

  // ========== 2. CHECK LIMITS ==========
  const limitViolation = await LimitValidationService.checkLimitsBeforeRequest(
    agent.id,
  );

  if (limitViolation) {
    const [_refusalMessage, contentMessage] = limitViolation;
    logger.info(
      { agentId: agent.id, reason: "token_cost_limit_exceeded" },
      "LLMProxy.handleRequest: Limit exceeded",
    );
    throw new LimitExceededError(contentMessage);
  }

  // ========== 3. CONVERT TO OPENAI FORMAT ==========
  const openaiRequest = transformer.requestToOpenAI(request);

  logger.info(
    {
      agentId: agent.id,
      model: openaiRequest.model,
      stream,
      messagesCount: openaiRequest.messages.length,
      toolsCount: openaiRequest.tools?.length || 0,
    },
    "LLMProxy.handleRequest: Request converted to OpenAI format",
  );

  // ========== 4. PERSIST TOOLS ==========
  if (openaiRequest.tools && openaiRequest.tools.length > 0) {
    const toolsToTransform = openaiRequest.tools
      .filter((t): t is OpenAi.Types.FunctionTool => t.type === "function")
      .map((t) => ({
        toolName: t.function.name,
        toolParameters: t.function.parameters,
        toolDescription: t.function.description,
      }));

    await tools.persistTools(toolsToTransform, agent.id);
  }

  const enabledToolNames = new Set(
    openaiRequest.tools
      ?.filter((t): t is OpenAi.Types.FunctionTool => t.type === "function")
      .map((t) => t.function.name)
      .filter(Boolean) ?? [],
  );

  // ========== 5. COST OPTIMIZATION ==========
  const originalModel = openaiRequest.model;
  const hasTools = (openaiRequest.tools?.length ?? 0) > 0;
  const optimizedModel = await costOptimization.getOptimizedModel(
    agent,
    openaiRequest.messages,
    "openai",
    hasTools,
  );
  const model = optimizedModel ?? originalModel;

  if (optimizedModel) {
    logger.info(
      { agentId: agent.id, optimizedModel },
      "LLMProxy.handleRequest: Model optimized",
    );
  }

  // ========== 6. ENSURE TOKEN PRICES EXIST ==========
  const baselinePricing = getDefaultPricing(originalModel);
  await TokenPriceModel.createIfNotExists(originalModel, {
    provider: provider.name,
    ...baselinePricing,
  });

  if (model !== originalModel) {
    const optimizedPricing = getDefaultPricing(model);
    await TokenPriceModel.createIfNotExists(model, {
      provider: provider.name,
      ...optimizedPricing,
    });
  }

  // ========== 7. TRUSTED DATA EVALUATION ==========
  const commonMessages = adapters.openai.toCommonFormat(openaiRequest.messages);

  const { toolResultUpdates, contextIsTrusted } =
    await trustedData.evaluateIfContextIsTrusted(
      commonMessages,
      agent.id,
      apiKey,
      provider.name,
      agent.considerContextUntrusted,
      stream ? dualLlmCallbacks?.onDualLlmStart : undefined,
      stream ? dualLlmCallbacks?.onDualLlmProgress : undefined,
    );

  let messages = adapters.openai.applyUpdates(
    openaiRequest.messages,
    toolResultUpdates,
  );

  logger.info(
    {
      agentId: agent.id,
      originalMessagesCount: openaiRequest.messages.length,
      filteredMessagesCount: messages.length,
      contextIsTrusted,
    },
    "LLMProxy.handleRequest: Trusted data evaluated",
  );

  // ========== 8. TOON COMPRESSION ==========
  type ToonStats = {
    tokensBefore: number | null;
    tokensAfter: number | null;
    costSavings: number | null;
  } | null;

  let toonStats: ToonStats = null;
  const shouldApplyToon = await toonConversion.shouldApplyToonCompression(
    agent.id,
  );

  if (shouldApplyToon) {
    const { messages: convertedMessages, stats } =
      await adapters.openai.convertToolResultsToToon(messages, model);
    messages = convertedMessages;
    toonStats = {
      tokensBefore: stats.toonTokensBefore,
      tokensAfter: stats.toonTokensAfter,
      costSavings: stats.toonCostSavings,
    };
    logger.debug(
      { toonStats },
      "LLMProxy.handleRequest: TOON compression applied",
    );
  }

  // ========== 9. BUILD PROCESSED REQUEST ==========
  const processedOpenaiRequest: OpenAIRequest = {
    ...openaiRequest,
    messages,
    model,
  };

  // Convert back to provider format for API call
  const providerRequest = transformer.requestFromOpenAI(
    processedOpenaiRequest,
  );

  // Build context for API calls
  const proxyContext: ProxyContext = {
    apiKey,
    agent,
    externalAgentId,
  };

  // ========== 10. MAKE API CALL ==========
  if (stream) {
    await handleStreaming({
      provider,
      providerRequest,
      proxyContext,
      reply,
      agent,
      originalModel,
      optimizedModel: model,
      contextIsTrusted,
      enabledToolNames,
      toonStats,
      nativeRequest: request,
      originalRequest: openaiRequest,
      processedRequest: processedOpenaiRequest,
      externalAgentId,
      userId,
    });
  } else {
    await handleNonStreaming({
      provider,
      providerRequest,
      proxyContext,
      reply,
      agent,
      originalModel,
      optimizedModel: model,
      contextIsTrusted,
      enabledToolNames,
      toonStats,
      nativeRequest: request,
      originalRequest: openaiRequest,
      processedRequest: processedOpenaiRequest,
      externalAgentId,
      userId,
    });
  }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

interface ProcessingParams<TRequest, TResponse, TStreamEvent> {
  provider: Provider<TRequest, TResponse, TStreamEvent>;
  providerRequest: TRequest;
  proxyContext: ProxyContext;
  reply: FastifyReply;
  agent: Agent;
  originalModel: string;
  optimizedModel: string;
  contextIsTrusted: boolean;
  enabledToolNames: Set<string>;
  toonStats: {
    tokensBefore: number | null;
    tokensAfter: number | null;
    costSavings: number | null;
  } | null;
  /** Original native-format request (before OpenAI conversion) - stored in DB */
  nativeRequest: TRequest;
  /** OpenAI-format request before cost optimization - used for processing */
  originalRequest: OpenAIRequest;
  /** OpenAI-format request after cost optimization - used for processing */
  processedRequest: OpenAIRequest;
  externalAgentId?: string;
  userId?: string;
}

/**
 * Handle non-streaming API call
 */
async function handleNonStreaming<TRequest, TResponse, TStreamEvent>(
  params: ProcessingParams<TRequest, TResponse, TStreamEvent>,
): Promise<void> {
  const {
    provider,
    providerRequest,
    proxyContext,
    reply,
    agent,
    originalModel,
    optimizedModel,
    contextIsTrusted,
    enabledToolNames,
    toonStats,
    nativeRequest,
    originalRequest,
    processedRequest,
    externalAgentId,
    userId,
  } = params;

  // Make API call
  const providerResponse = await provider.call(providerRequest, proxyContext);

  // Convert to OpenAI format for processing
  const openaiResponse =
    provider.transformer.responseToOpenAI(providerResponse);

  // Run post-processing (stores interaction in native format)
  const { response: processedResponse, wasBlocked } = await runPostProcessing({
    response: openaiResponse,
    agent,
    originalModel,
    optimizedModel,
    contextIsTrusted,
    enabledToolNames,
    toonStats,
    nativeRequest,
    originalRequest,
    processedRequest,
    interactionType: provider.interactionType,
    externalAgentId,
    userId,
    // Converters for storing in native format
    requestFromOpenAI: (req) =>
      provider.transformer.requestFromOpenAI(req),
    responseFromOpenAI: (res) =>
      provider.transformer.responseFromOpenAI(res),
  });

  // Convert back to provider format and send
  const finalResponse = wasBlocked
    ? provider.transformer.responseFromOpenAI(processedResponse)
    : providerResponse;

  reply.send(finalResponse);
}

/**
 * Handle streaming API call
 *
 * Uses chunk-by-chunk OpenAI format conversion:
 * 1. Convert each native event to OpenAI chunk
 * 2. Buffer tool call chunks for policy evaluation
 * 3. Stream non-tool chunks
 * 4. After streaming, evaluate policies and flush or replace tool chunks
 */
async function handleStreaming<TRequest, TResponse, TStreamEvent>(
  params: ProcessingParams<TRequest, TResponse, TStreamEvent>,
): Promise<void> {
  const {
    provider,
    providerRequest,
    proxyContext,
    reply,
    agent,
    originalModel,
    optimizedModel,
    contextIsTrusted,
    enabledToolNames,
    toonStats,
    nativeRequest,
    originalRequest,
    processedRequest,
    externalAgentId,
    userId,
  } = params;

  provider.setupStreamingHeaders(reply);

  const streamResult = await provider.stream(providerRequest, proxyContext);

  const streamTransformer = provider.transformer.createStreamTransformer();

  const bufferedToolChunks: OpenAIStreamChunk[] = [];
  let hasToolCalls = false;

  for await (const nativeEvent of streamResult.events) {
    const chunk = streamTransformer.toOpenAI(nativeEvent);

    if (!chunk) continue;

    // Buffer tool chunks for policy evaluation
    // Non-tool chunks are streamed immediately
    if (streamTransformer.isToolChunk(chunk)) {
      hasToolCalls = true;
      bufferedToolChunks.push(chunk);
    } else {
      streamTransformer.writeFromOpenAI(reply, chunk);
    }
  }

  // Get accumulated response for post-processing (metrics, interaction recording)
  const accumulatedResponse = await streamResult.getAccumulatedResponse();
  const openaiResponse =
    provider.transformer.responseToOpenAI(accumulatedResponse);

  // Run post-processing (stores interaction in native format)
  const { response: processedResponse, wasBlocked } = await runPostProcessing({
    response: openaiResponse,
    agent,
    originalModel,
    optimizedModel,
    contextIsTrusted,
    enabledToolNames,
    toonStats,
    nativeRequest,
    originalRequest,
    processedRequest,
    interactionType: provider.interactionType,
    externalAgentId,
    userId,
    requestFromOpenAI: (req) =>
      provider.transformer.requestFromOpenAI(req),
    responseFromOpenAI: (res) =>
      provider.transformer.responseFromOpenAI(res),
  });

  // Handle tool calls based on policy result
  if (hasToolCalls) {
    if (wasBlocked) {
      // Stream refusal message as a text content chunk
      const refusalContent =
        processedResponse.choices[0]?.message?.content ?? "Blocked by policy";
      streamTransformer.writeFromOpenAI(reply, {
        id: openaiResponse.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: openaiResponse.model,
        choices: [
          { index: 0, delta: { content: refusalContent }, finish_reason: null },
        ],
      });
    } else {
      // Encode and stream the buffered tool call chunks (in native SSE format)
      for (const chunk of bufferedToolChunks) {
        streamTransformer.writeFromOpenAI(reply, chunk);
      }
    }
  }

  // Send finish chunk with finish_reason (encoder converts to terminal events)
  const finishReason = wasBlocked
    ? "stop"
    : (openaiResponse.choices[0]?.finish_reason ?? "stop");
  streamTransformer.writeFromOpenAI(reply, {
    id: openaiResponse.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: openaiResponse.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });

  reply.raw.end();
}

/**
 * Reconstruct tool calls from buffered OpenAI stream chunks.
 * Used for policy evaluation when tool call chunks are buffered.
 */
export function reconstructToolCallsFromChunks(
  chunks: OpenAIStreamChunk[],
): Array<{ id: string; name: string; arguments: string }> {
  const toolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for (const chunk of chunks) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta || !("tool_calls" in delta) || !delta.tool_calls) continue;

    for (const tc of delta.tool_calls) {
      const index = tc.index ?? 0;
      const existing = toolCalls.get(index) ?? {
        id: "",
        name: "",
        arguments: "",
      };

      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;

      toolCalls.set(index, existing);
    }
  }

  return Array.from(toolCalls.values());
}

interface PostProcessingParams<TRequest, TResponse> {
  response: OpenAIResponse;
  agent: Agent;
  originalModel: string;
  optimizedModel: string;
  contextIsTrusted: boolean;
  enabledToolNames: Set<string>;
  toonStats: {
    tokensBefore: number | null;
    tokensAfter: number | null;
    costSavings: number | null;
  } | null;
  /** Original native-format request (before OpenAI conversion) - stored in DB */
  nativeRequest: TRequest;
  /** OpenAI-format request before cost optimization */
  originalRequest: OpenAIRequest;
  /** OpenAI-format request after cost optimization */
  processedRequest: OpenAIRequest;
  interactionType: SupportedProviderDiscriminator;
  externalAgentId?: string;
  userId?: string;
  /** Convert OpenAI request back to native format for storage */
  requestFromOpenAI: (req: OpenAIRequest) => TRequest;
  /** Convert OpenAI response back to native format for storage */
  responseFromOpenAI: (res: OpenAIResponse) => TResponse;
}

/**
 * Run post-processing: policy evaluation, metrics, interaction recording
 * Stores interactions in native provider format (not OpenAI format)
 */
async function runPostProcessing<TRequest, TResponse>(
  params: PostProcessingParams<TRequest, TResponse>,
): Promise<{ response: OpenAIResponse; wasBlocked: boolean }> {
  const {
    response,
    agent,
    originalModel,
    optimizedModel,
    contextIsTrusted,
    enabledToolNames,
    toonStats,
    nativeRequest,
    processedRequest,
    interactionType,
    externalAgentId,
    userId,
    requestFromOpenAI,
    responseFromOpenAI,
  } = params;

  let processedResponse = response;
  let wasBlocked = false;

  // 1. Evaluate tool invocation policies
  const choice = response.choices[0];
  if (choice?.message.tool_calls?.length) {
    const toolCallsForEvaluation = choice.message.tool_calls
      .filter(
        (tc): tc is OpenAi.Types.FunctionToolCall => tc.type === "function",
      )
      .map((tc) => ({
        toolCallName: tc.function.name,
        toolCallArgs: tc.function.arguments,
      }));

    const refusal = await toolInvocation.evaluatePolicies(
      toolCallsForEvaluation,
      agent.id,
      contextIsTrusted,
      enabledToolNames,
    );

    if (refusal) {
      const [_refusalMessage, contentMessage] = refusal;
      logger.info(
        { agentId: agent.id, toolCallCount: choice.message.tool_calls.length },
        "LLMProxy.handleRequest: Tool calls blocked by policy",
      );

      processedResponse = {
        ...response,
        choices: [
          {
            ...choice,
            message: {
              role: "assistant",
              content: contentMessage,
              tool_calls: undefined,
            },
            finish_reason: "stop",
          },
        ],
      };
      wasBlocked = true;

      reportBlockedTools(
        "openai",
        agent,
        choice.message.tool_calls.length,
        optimizedModel,
        externalAgentId,
      );
    }
  }

  // 2. Report metrics
  const inputTokens = response.usage?.prompt_tokens ?? null;
  const outputTokens = response.usage?.completion_tokens ?? null;

  if (inputTokens !== null && outputTokens !== null) {
    reportLLMTokens(
      "openai",
      agent,
      { input: inputTokens, output: outputTokens },
      optimizedModel,
      externalAgentId,
    );
  }

  // 3. Calculate costs
  const baselineCost = await costOptimization.calculateCost(
    originalModel,
    inputTokens,
    outputTokens,
  );

  const actualCost = await costOptimization.calculateCost(
    optimizedModel,
    inputTokens,
    outputTokens,
  );

  if (actualCost !== undefined) {
    reportLLMCost("openai", agent, optimizedModel, actualCost, externalAgentId);
  }

  logger.info(
    {
      model: optimizedModel,
      baselineModel: originalModel,
      baselineCost,
      actualCost,
      inputTokens,
      outputTokens,
    },
    "LLMProxy.handleRequest: Costs calculated",
  );

  // 4. Record interaction in native provider format
  // Convert OpenAI format back to native format for storage
  const nativeProcessedRequest = requestFromOpenAI(processedRequest);
  const nativeResponse = responseFromOpenAI(processedResponse);

  // Cast to the expected types - we know these are compatible at runtime
  // since the transformer converts to/from the correct provider format
  await InteractionModel.create({
    profileId: agent.id,
    externalAgentId,
    userId,
    type: interactionType,
    request: nativeRequest as Parameters<
      typeof InteractionModel.create
    >[0]["request"],
    processedRequest: nativeProcessedRequest as Parameters<
      typeof InteractionModel.create
    >[0]["processedRequest"],
    response: nativeResponse as Parameters<
      typeof InteractionModel.create
    >[0]["response"],
    model: optimizedModel,
    inputTokens,
    outputTokens,
    cost: actualCost?.toFixed(10) ?? null,
    baselineCost: baselineCost?.toFixed(10) ?? null,
    toonTokensBefore: toonStats?.tokensBefore ?? null,
    toonTokensAfter: toonStats?.tokensAfter ?? null,
    toonCostSavings: toonStats?.costSavings?.toFixed(10) ?? null,
  });

  return { response: processedResponse, wasBlocked };
}

/**
 * Options for handleRequestWithErrors - includes logger for error logging
 */
export interface HandleRequestWithErrorsOptions<
  TRequest,
  TResponse,
  TStreamEvent,
> extends HandleRequestOptions<TRequest, TResponse, TStreamEvent> {
  log?: { error: (err: unknown) => void };
}

/**
 * Wrapper around handleRequest that catches errors and formats them in the provider's expected format.
 */
export async function handleRequestWithErrors<
  TRequest,
  TResponse,
  TStreamEvent,
>(
  options: HandleRequestWithErrorsOptions<TRequest, TResponse, TStreamEvent>,
): Promise<void> {
  const { provider, reply, stream, log } = options;

  try {
    await handleRequest(options);
  } catch (error) {
    // Special handling for rate limit errors
    if (error instanceof LimitExceededError) {
      reply.status(429).send({
        error: {
          message: error.message,
          type: "rate_limit_exceeded",
          code: "token_cost_limit_exceeded",
        },
      });
      return;
    }

    // Log the error
    log?.error(error);

    const statusCode = provider.getErrorStatusCode(error);

    if (stream) {
      // For streaming, write error event and close stream
      if (reply.sent) {
        // Response already started - write error to stream
        provider.writeStreamError(reply, error);
      } else {
        // Response not yet started - send error as first (and only) chunk
        provider.setupStreamingHeaders(reply);
        provider.writeStreamError(reply, error);
      }
      return;
    }

    // For non-streaming, send error response
    const errorResponse = provider.formatErrorResponse(error);
    reply.status(statusCode).send(errorResponse);
  }
}
