/**
 * Generic LLM Proxy Handler
 *
 * A reusable handler that works with any LLM provider through the adapter pattern.
 * Routes choose which adapter factory to use based on URL.
 */

import type { FastifyReply } from "fastify";
import config from "@/config";
import getDefaultPricing from "@/default-model-prices";
import {
  getObservableFetch,
  reportBlockedTools,
  reportLLMCost,
  reportLLMTokens,
  reportTimeToFirstToken,
  reportTokensPerSecond,
} from "@/llm-metrics";
import logger from "@/logging";
import {
  AgentModel,
  InteractionModel,
  LimitValidationService,
  TokenPriceModel,
} from "@/models";
import type {
  Agent,
  InteractionRequest,
  InteractionResponse,
  LLMProvider,
  LLMStreamAdapter,
  ToonCompressionResult,
} from "@/types";
import * as utils from "./utils";

export interface Context {
  organizationId: string;
  agentId?: string;
  externalAgentId?: string;
  userId?: string;
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
  headers: THeaders,
  reply: FastifyReply,
  provider: LLMProvider<TRequest, TResponse, TMessages, TChunk, THeaders>,
  context: Context,
): Promise<FastifyReply> {
  const { agentId, externalAgentId } = context;
  const providerName = provider.provider;

  const requestAdapter = provider.createRequestAdapter(body);
  const streamAdapter = provider.createStreamAdapter();

  logger.debug(
    {
      agentId,
      model: requestAdapter.getModel(),
      stream: requestAdapter.isStreaming(),
      messagesCount: requestAdapter.getProviderMessages(),
      toolsCount: requestAdapter.getTools().length,
    },
    `[${providerName}Proxy] handleLLMProxy: request received`,
  );

  // Resolve agent
  let resolvedAgent: Agent;
  if (agentId) {
    logger.debug(
      { agentId },
      `[${providerName}Proxy] Resolving explicit agent by ID`,
    );
    const agent = await AgentModel.findById(agentId);
    if (!agent) {
      logger.debug({ agentId }, `[${providerName}Proxy] Agent not found`);
      return reply.status(404).send({
        error: {
          message: `Agent with ID ${agentId} not found`,
          type: "not_found",
        },
      });
    }
    resolvedAgent = agent;
  } else {
    logger.debug(
      { userAgent: (headers as Record<string, unknown>)["user-agent"] },
      `[${providerName}Proxy] Resolving default agent by user-agent`,
    );
    resolvedAgent = await AgentModel.getAgentOrCreateDefault(
      (headers as Record<string, unknown>)["user-agent"] as string | undefined,
    );
  }

  const resolvedAgentId = resolvedAgent.id;
  logger.debug(
    { resolvedAgentId, agentName: resolvedAgent.name, wasExplicit: !!agentId },
    `[${providerName}Proxy] Agent resolved`,
  );

  // Extract API key
  const apiKey = provider.extractApiKey(headers);

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

    // Persist tools declared by client
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

    // Ensure token prices exist
    const baselinePricing = getDefaultPricing(baselineModel);
    await TokenPriceModel.createIfNotExists(baselineModel, {
      provider: providerName,
      ...baselinePricing,
    });

    if (actualModel !== baselineModel) {
      const optimizedPricing = getDefaultPricing(actualModel);
      await TokenPriceModel.createIfNotExists(actualModel, {
        provider: providerName,
        ...optimizedPricing,
      });
    }

    // Set SSE headers early if streaming
    if (requestAdapter.isStreaming()) {
      logger.debug(
        `[${providerName}Proxy] Setting up streaming response headers`,
      );
      const sseHeaders = streamAdapter.getSSEHeaders();
      for (const [key, value] of Object.entries(sseHeaders)) {
        reply.header(key, value);
      }
    }

    // Evaluate trusted data policies
    logger.debug(
      {
        resolvedAgentId,
        considerContextUntrusted: resolvedAgent.considerContextUntrusted,
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
        // Streaming callbacks for dual LLM progress
        requestAdapter.isStreaming()
          ? () => {
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
    let toonStats: ToonCompressionResult = {
      tokensBefore: null,
      tokensAfter: null,
      costSavings: null,
    };

    const shouldApplyToonCompression =
      await utils.toonConversion.shouldApplyToonCompression(resolvedAgentId);

    if (shouldApplyToonCompression) {
      toonStats = await requestAdapter.applyToonCompression(actualModel);
    }

    logger.info(
      {
        shouldApplyToonCompression,
        toonTokensBefore: toonStats.tokensBefore,
        toonTokensAfter: toonStats.tokensAfter,
        toonCostSavings: toonStats.costSavings,
      },
      `${providerName} proxy: tool results compression completed`,
    );

    // Create client
    const client = provider.createClient(apiKey, {
      baseUrl: provider.getBaseUrl(),
      fetch: getObservableFetch(providerName, resolvedAgent, externalAgentId),
      mockMode: config.benchmark.mockMode,
    });

    // Build final request
    const finalRequest = requestAdapter.toProviderRequest();

    // Extract enabled tool names for filtering in evaluatePolicies
    const enabledToolNames = new Set(tools.map((t) => t.name).filter(Boolean));

    if (requestAdapter.isStreaming()) {
      return handleStreaming(
        client,
        finalRequest,
        reply,
        provider,
        streamAdapter,
        resolvedAgent,
        contextIsTrusted,
        baselineModel,
        actualModel,
        requestAdapter.getOriginalRequest(),
        toonStats,
        enabledToolNames,
        externalAgentId,
        context.userId,
      );
    } else {
      return handleNonStreaming(
        client,
        finalRequest,
        reply,
        provider,
        resolvedAgent,
        contextIsTrusted,
        baselineModel,
        actualModel,
        requestAdapter.getOriginalRequest(),
        toonStats,
        enabledToolNames,
        externalAgentId,
        context.userId,
      );
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
  agent: Agent,
  contextIsTrusted: boolean,
  baselineModel: string,
  actualModel: string,
  originalRequest: TRequest,
  toonStats: ToonCompressionResult,
  enabledToolNames: Set<string>,
  externalAgentId?: string,
  userId?: string,
): Promise<FastifyReply> {
  const providerName = provider.provider;
  const streamStartTime = Date.now();
  let firstChunkTime: number | undefined;
  let streamCompleted = false;

  logger.debug(
    { model: actualModel },
    `[${providerName}Proxy] Starting streaming request`,
  );

  try {
    // Execute streaming request with tracing
    const stream = await utils.tracing.startActiveLlmSpan(
      provider.getSpanName(true),
      providerName,
      actualModel,
      true,
      agent,
      async (llmSpan) => {
        const result = await provider.executeStream(client, request);
        llmSpan.end();
        return result;
      },
    );

    // Process chunks
    for await (const chunk of stream) {
      // Track first chunk time
      if (!firstChunkTime) {
        firstChunkTime = Date.now();
        const ttftSeconds = (firstChunkTime - streamStartTime) / 1000;
        reportTimeToFirstToken(
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
        reply.raw.write(result.sseData);
      }

      if (result.isFinal) {
        break;
      }
    }

    logger.info("Stream loop completed, processing final events");

    // Evaluate tool invocation policies
    const toolCalls = streamAdapter.state.toolCalls;
    let toolInvocationRefusal: [string, string] | null = null;

    if (toolCalls.length > 0) {
      logger.info(
        {
          toolCallCount: toolCalls.length,
          toolNames: toolCalls.map((tc) => tc.name),
        },
        "Evaluating tool invocation policies",
      );

      // Parse tool arguments for policy evaluation
      const toolCallsForPolicy = toolCalls.map((tc) => {
        let argsString = tc.arguments;
        try {
          // Verify it's valid JSON
          JSON.parse(tc.arguments);
        } catch {
          // If not valid JSON, wrap it
          argsString = JSON.stringify({ raw: tc.arguments });
        }
        return {
          toolCallName: tc.name,
          toolCallArgs: argsString,
        };
      });

      toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
        toolCallsForPolicy,
        agent.id,
        contextIsTrusted,
        enabledToolNames,
      );

      logger.info(
        { refused: !!toolInvocationRefusal },
        "Tool invocation policy result",
      );
    }

    if (toolInvocationRefusal) {
      const [_refusalMessage, contentMessage] = toolInvocationRefusal;

      // Stream refusal
      const refusalEvents = streamAdapter.formatCompleteTextSSE(contentMessage);
      for (const event of refusalEvents) {
        reply.raw.write(event);
      }

      reportBlockedTools(
        providerName,
        agent,
        toolCalls.length,
        actualModel,
        externalAgentId,
      );
    } else if (toolCalls.length > 0) {
      // Tool calls approved - stream raw events
      logger.info(
        { toolCallCount: toolCalls.length },
        "Tool calls allowed, streaming them now",
      );

      const rawEvents = streamAdapter.getRawToolCallEvents();
      for (const event of rawEvents) {
        reply.raw.write(event);
      }
    }

    // Stream end events
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
      reportLLMTokens(
        providerName,
        agent,
        { input: usage.inputTokens, output: usage.outputTokens },
        actualModel,
        externalAgentId,
      );

      if (usage.outputTokens && firstChunkTime) {
        const totalDurationSeconds = (Date.now() - streamStartTime) / 1000;
        reportTokensPerSecond(
          providerName,
          agent,
          actualModel,
          usage.outputTokens,
          totalDurationSeconds,
          externalAgentId,
        );
      }

      const baselineCost = await utils.costOptimization.calculateCost(
        baselineModel,
        usage.inputTokens,
        usage.outputTokens,
      );
      const actualCost = await utils.costOptimization.calculateCost(
        actualModel,
        usage.inputTokens,
        usage.outputTokens,
      );

      reportLLMCost(
        providerName,
        agent,
        actualModel,
        actualCost,
        externalAgentId,
      );

      await InteractionModel.create({
        profileId: agent.id,
        externalAgentId,
        userId,
        type: provider.interactionType,
        // Cast generic types to interaction types - valid at runtime
        request: originalRequest as unknown as InteractionRequest,
        processedRequest: request as unknown as InteractionRequest,
        response:
          streamAdapter.toProviderResponse() as unknown as InteractionResponse,
        model: actualModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: actualCost?.toFixed(10) ?? null,
        baselineCost: baselineCost?.toFixed(10) ?? null,
        toonTokensBefore: toonStats.tokensBefore,
        toonTokensAfter: toonStats.tokensAfter,
        toonCostSavings: toonStats.costSavings?.toFixed(10) ?? null,
      });
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
  agent: Agent,
  contextIsTrusted: boolean,
  baselineModel: string,
  actualModel: string,
  originalRequest: TRequest,
  toonStats: ToonCompressionResult,
  enabledToolNames: Set<string>,
  externalAgentId?: string,
  userId?: string,
): Promise<FastifyReply> {
  const providerName = provider.provider;

  logger.debug(
    { model: actualModel },
    `[${providerName}ProxyV2] Starting non-streaming request`,
  );

  // Execute request with tracing
  const response = await utils.tracing.startActiveLlmSpan(
    provider.getSpanName(false),
    providerName,
    actualModel,
    false,
    agent,
    async (llmSpan: { end: () => void }) => {
      const result = await provider.execute(client, request);
      llmSpan.end();
      return result;
    },
  );

  // Create response adapter
  const responseAdapter = provider.createResponseAdapter(response);

  const toolCalls = responseAdapter.getToolCalls();
  logger.debug(
    { toolCallCount: toolCalls.length },
    `[${providerName}Proxy] Non-streaming response received, checking tool invocation policies`,
  );

  // Evaluate tool invocation policies
  if (toolCalls.length > 0) {
    const toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
      toolCalls.map((tc) => ({
        toolCallName: tc.name,
        toolCallArgs:
          typeof tc.arguments === "string"
            ? tc.arguments
            : JSON.stringify(tc.arguments),
      })),
      agent.id,
      contextIsTrusted,
      enabledToolNames,
    );

    if (toolInvocationRefusal) {
      const [refusalMessage, contentMessage] = toolInvocationRefusal;
      logger.debug(
        { toolCallCount: toolCalls.length },
        `[${providerName}Proxy] Tool invocation blocked by policy`,
      );

      const refusalResponse = responseAdapter.toRefusalResponse(
        refusalMessage,
        contentMessage,
      );

      reportBlockedTools(
        providerName,
        agent,
        toolCalls.length,
        actualModel,
        externalAgentId,
      );

      // Record interaction with refusal
      const usage = responseAdapter.getUsage();
      const baselineCost = await utils.costOptimization.calculateCost(
        baselineModel,
        usage.inputTokens,
        usage.outputTokens,
      );
      const actualCost = await utils.costOptimization.calculateCost(
        actualModel,
        usage.inputTokens,
        usage.outputTokens,
      );

      reportLLMCost(
        providerName,
        agent,
        actualModel,
        actualCost,
        externalAgentId,
      );

      await InteractionModel.create({
        profileId: agent.id,
        externalAgentId,
        userId,
        type: provider.interactionType,
        // Cast generic types to interaction types - valid at runtime
        request: originalRequest as unknown as InteractionRequest,
        processedRequest: request as unknown as InteractionRequest,
        response: refusalResponse as unknown as InteractionResponse,
        model: actualModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: actualCost?.toFixed(10) ?? null,
        baselineCost: baselineCost?.toFixed(10) ?? null,
        toonTokensBefore: toonStats.tokensBefore,
        toonTokensAfter: toonStats.tokensAfter,
        toonCostSavings: toonStats.costSavings?.toFixed(10) ?? null,
      });

      return reply.send(refusalResponse);
    }
  }

  // Tool calls allowed (or no tool calls) - return response
  const usage = responseAdapter.getUsage();

  reportLLMTokens(
    providerName,
    agent,
    { input: usage.inputTokens, output: usage.outputTokens },
    actualModel,
    externalAgentId,
  );

  const baselineCost = await utils.costOptimization.calculateCost(
    baselineModel,
    usage.inputTokens,
    usage.outputTokens,
  );
  const actualCost = await utils.costOptimization.calculateCost(
    actualModel,
    usage.inputTokens,
    usage.outputTokens,
  );

  reportLLMCost(providerName, agent, actualModel, actualCost, externalAgentId);

  await InteractionModel.create({
    profileId: agent.id,
    externalAgentId,
    userId,
    type: provider.interactionType,
    // Cast generic types to interaction types - valid at runtime
    request: originalRequest as unknown as InteractionRequest,
    processedRequest: request as unknown as InteractionRequest,
    response:
      responseAdapter.getOriginalResponse() as unknown as InteractionResponse,
    model: actualModel,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost: actualCost?.toFixed(10) ?? null,
    baselineCost: baselineCost?.toFixed(10) ?? null,
    toonTokensBefore: toonStats.tokensBefore,
    toonTokensAfter: toonStats.tokensAfter,
    toonCostSavings: toonStats.costSavings?.toFixed(10) ?? null,
  });

  return reply.send(responseAdapter.getOriginalResponse());
}

// =============================================================================
// HELPERS
// =============================================================================

function handleError(
  error: unknown,
  reply: FastifyReply,
  extractErrorMessage: (error: unknown) => string,
  isStreaming: boolean,
): FastifyReply {
  logger.error(error);

  const statusCode =
    error instanceof Error && "status" in error
      ? (error.status as 200 | 400 | 404 | 403 | 500)
      : 500;

  const errorMessage = extractErrorMessage(error);

  if (isStreaming) {
    const errorEvent = {
      type: "error",
      error: {
        type: "api_error",
        message: errorMessage,
      },
    };

    if (reply.sent) {
      // Headers already sent, write to stream
      reply.raw.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
      reply.raw.end();
    } else {
      // Headers not sent, send as SSE format
      const sseError = `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`;
      return reply.status(200).send(sseError);
    }
    return reply;
  }

  // Non-streaming error
  return reply.status(statusCode).send({
    error: {
      message: errorMessage,
      type: "api_error",
    },
  });
}
