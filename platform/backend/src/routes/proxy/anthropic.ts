import AnthropicProvider from "@anthropic-ai/sdk";
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { get } from "lodash-es";
import { z } from "zod";
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
import {
  type Agent,
  Anthropic,
  constructResponseSchema,
  UuidIdSchema,
} from "@/types";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "./common";
import { MockAnthropicClient } from "./mock-anthropic-client";
import * as utils from "./utils";

const anthropicProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/anthropic`;
  const MESSAGES_SUFFIX = "/messages";

  /**
   * Register HTTP proxy for Anthropic routes
   * Handles both patterns:
   * - /v1/anthropic/:agentId/* -> https://api.anthropic.com/v1/* (agentId stripped if UUID)
   * - /v1/anthropic/* -> https://api.anthropic.com/v1/* (direct proxy)
   *
   * Messages are excluded and handled separately below with full agent support
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.anthropic.baseUrl,
    prefix: `${API_PREFIX}`,
    rewritePrefix: "/v1",
    preHandler: (request, _reply, next) => {
      // Skip messages route (we handle it specially below with full agent support)
      if (request.method === "POST" && request.url.includes(MESSAGES_SUFFIX)) {
        fastify.log.info(
          {
            method: request.method,
            url: request.url,
            action: "skip-proxy",
            reason: "handled-by-custom-handler",
          },
          "Anthropic proxy preHandler: skipping messages route",
        );
        next(new Error("skip"));
        return;
      }

      // Check if URL has UUID segment that needs stripping
      const pathAfterPrefix = request.url.replace(API_PREFIX, "");
      const uuidMatch = pathAfterPrefix.match(
        /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
      );

      if (uuidMatch) {
        // Strip UUID: /v1/anthropic/:uuid/path -> /v1/anthropic/path
        const remainingPath = uuidMatch[2] || "";
        const originalUrl = request.raw.url;
        request.raw.url = `${API_PREFIX}${remainingPath}`;

        fastify.log.info(
          {
            method: request.method,
            originalUrl,
            rewrittenUrl: request.raw.url,
            upstream: config.llm.anthropic.baseUrl,
            finalProxyUrl: `${config.llm.anthropic.baseUrl}/v1${remainingPath}`,
          },
          "Anthropic proxy preHandler: URL rewritten (UUID stripped)",
        );
      } else {
        fastify.log.info(
          {
            method: request.method,
            url: request.url,
            upstream: config.llm.anthropic.baseUrl,
            finalProxyUrl: `${config.llm.anthropic.baseUrl}/v1${pathAfterPrefix}`,
          },
          "Anthropic proxy preHandler: proxying request",
        );
      }

      next();
    },
  });

  const handleMessages = async (
    body: Anthropic.Types.MessagesRequest,
    headers: Anthropic.Types.MessagesHeaders,
    reply: FastifyReply,
    _organizationId: string,
    agentId?: string,
    externalAgentId?: string,
    userId?: string,
  ) => {
    const { tools, stream } = body;

    logger.debug(
      {
        agentId,
        model: body.model,
        stream,
        messagesCount: body.messages.length,
        toolsCount: tools?.length || 0,
        maxTokens: body.max_tokens,
        hasSystem: !!body.system,
      },
      "[AnthropicProxy] handleMessages: request received",
    );

    // Debug: Log message structure
    if (body.messages.length > 0) {
      logger.debug(
        {
          messages: body.messages.map((msg, idx) => ({
            index: idx,
            role: msg.role,
            contentType: typeof msg.content,
            contentBlocks: Array.isArray(msg.content)
              ? msg.content.map((block) => block.type)
              : null,
          })),
        },
        "[AnthropicProxy] handleMessages: message structure",
      );
    }

    let resolvedAgent: Agent;
    if (agentId) {
      // If agentId provided via URL, validate it exists
      logger.debug(
        { agentId },
        "[AnthropicProxy] Resolving explicit agent by ID",
      );
      const agent = await AgentModel.findById(agentId);

      if (!agent) {
        logger.debug({ agentId }, "[AnthropicProxy] Agent not found");
        return reply.status(404).send({
          error: {
            message: `Agent with ID ${agentId} not found`,
            type: "not_found",
          },
        });
      }
      resolvedAgent = agent;
    } else {
      // Otherwise get or create default agent
      logger.debug(
        { userAgent: headers["user-agent"] },
        "[AnthropicProxy] Resolving default agent by user-agent",
      );
      resolvedAgent = await AgentModel.getAgentOrCreateDefault(
        headers["user-agent"],
      );
    }

    const resolvedAgentId = resolvedAgent.id;

    logger.debug(
      {
        resolvedAgentId,
        agentName: resolvedAgent.name,
        wasExplicit: !!agentId,
      },
      "[AnthropicProxy] Agent resolved",
    );

    const { "x-api-key": anthropicApiKey } = headers;

    const anthropicClient = config.benchmark.mockMode
      ? (new MockAnthropicClient() as unknown as AnthropicProvider)
      : new AnthropicProvider({
          apiKey: anthropicApiKey,
          baseURL: config.llm.anthropic.baseUrl,
          fetch: getObservableFetch(
            "anthropic",
            resolvedAgent,
            externalAgentId,
          ),
        });

    try {
      // Check if current usage limits are already exceeded
      logger.debug(
        { resolvedAgentId },
        "[AnthropicProxy] Checking usage limits",
      );
      const limitViolation =
        await LimitValidationService.checkLimitsBeforeRequest(resolvedAgentId);

      if (limitViolation) {
        const [_refusalMessage, contentMessage] = limitViolation;

        fastify.log.info(
          {
            resolvedAgentId,
            reason: "token_cost_limit_exceeded",
          },
          "Anthropic request blocked due to token cost limit",
        );

        // Return error response similar to tool call blocking
        return reply.status(429).send({
          error: {
            message: contentMessage,
            type: "rate_limit_exceeded",
            code: "token_cost_limit_exceeded",
          },
        });
      }
      logger.debug({ resolvedAgentId }, "[AnthropicProxy] Limit check passed");

      // Persist non-MCP tools declared by client for tracking
      if (tools) {
        logger.debug(
          { toolCount: tools.length },
          "[AnthropicProxy] Processing tools from request",
        );
        const transformedTools: Parameters<typeof utils.tools.persistTools>[0] =
          [];

        for (const tool of tools) {
          // null/undefined/type === custom essentially all mean the same thing for Anthropic tools...
          if (
            tool.type === undefined ||
            tool.type === null ||
            tool.type === "custom"
          ) {
            transformedTools.push({
              toolName: tool.name,
              toolParameters: tool.input_schema,
              toolDescription: tool.description,
            });
          }
        }

        await utils.tools.persistTools(transformedTools, resolvedAgentId);
      }

      // Client declares tools they want to use - no injection needed
      // Clients handle tool execution via MCP Gateway
      const mergedTools = tools || [];

      const baselineModel = body.model;
      let model = baselineModel;
      // Optimize model selection for cost using dynamic rules
      const hasTools = mergedTools.length > 0;
      const optimizedModel = await utils.costOptimization.getOptimizedModel(
        resolvedAgent,
        body.messages,
        "anthropic",
        hasTools,
      );

      if (optimizedModel) {
        model = optimizedModel;
        fastify.log.info(
          { resolvedAgentId, optimizedModel },
          "Optimized model selected",
        );
      } else {
        fastify.log.info(
          { resolvedAgentId, baselineModel },
          "No matching optimized model found, proceeding with baseline model",
        );
      }

      // Ensure TokenPrice records exist for both baseline and optimized models
      const baselinePricing = getDefaultPricing(baselineModel);
      await TokenPriceModel.createIfNotExists(baselineModel, {
        provider: "anthropic",
        ...baselinePricing,
      });

      if (model !== baselineModel) {
        const optimizedPricing = getDefaultPricing(model);
        await TokenPriceModel.createIfNotExists(model, {
          provider: "anthropic",
          ...optimizedPricing,
        });
      }

      // Convert to common format and evaluate trusted data policies
      logger.debug(
        { messageCount: body.messages.length },
        "[AnthropicProxy] Converting messages to common format",
      );
      const commonMessages = utils.adapters.anthropic.toCommonFormat(
        body.messages,
      );
      logger.debug(
        { commonMessageCount: commonMessages.length },
        "[AnthropicProxy] Messages converted to common format",
      );

      // For streaming requests, set headers first
      if (stream) {
        logger.debug("[AnthropicProxy] Setting up streaming response headers");
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-cache");
        reply.header("Connection", "keep-alive");

        // Forward Anthropic-specific rate limit headers
        reply.header("anthropic-ratelimit-requests-limit", "1000");
        reply.header("anthropic-ratelimit-requests-remaining", "999");
        reply.header(
          "anthropic-ratelimit-requests-reset",
          new Date(Date.now() + 60000).toISOString(),
        );
        reply.header("anthropic-ratelimit-tokens-limit", "100000");
        reply.header("anthropic-ratelimit-tokens-remaining", "99000");
        reply.header(
          "anthropic-ratelimit-tokens-reset",
          new Date(Date.now() + 60000).toISOString(),
        );
        reply.header("request-id", `req-proxy-${Date.now()}`);
      }

      logger.debug(
        {
          resolvedAgentId,
          considerContextUntrusted: resolvedAgent.considerContextUntrusted,
        },
        "[AnthropicProxy] Evaluating trusted data policies",
      );
      const { toolResultUpdates, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonMessages,
          resolvedAgentId,
          anthropicApiKey,
          "anthropic",
          resolvedAgent.considerContextUntrusted,
          stream
            ? () => {
                // Send initial indicator when dual LLM starts (streaming only)
                const startEvent = {
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "text_delta",
                    text: "Analyzing with Dual LLM:\n\n",
                  },
                };
                reply.raw.write(
                  `event: content_block_delta\ndata: ${JSON.stringify(
                    startEvent,
                  )}\n\n`,
                );
              }
            : undefined,
          stream
            ? (progress) => {
                // Stream Q&A progress with options
                const optionsText = progress.options
                  .map((opt, idx) => `  ${idx}: ${opt}`)
                  .join("\n");
                const progressEvent = {
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "text_delta",
                    text: `Question: ${progress.question}\nOptions:\n${optionsText}\nAnswer: ${progress.answer}\n\n`,
                  },
                };
                reply.raw.write(
                  `event: content_block_delta\ndata: ${JSON.stringify(
                    progressEvent,
                  )}\n\n`,
                );
              }
            : undefined,
        );

      // Apply updates back to Anthropic messages
      let filteredMessages = utils.adapters.anthropic.applyUpdates(
        body.messages,
        toolResultUpdates,
      );

      fastify.log.info(
        {
          resolvedAgentId,
          originalMessagesCount: body.messages.length,
          filteredMessagesCount: filteredMessages.length,
          toolResultUpdatesCount: toolResultUpdates.length,
          contextIsTrusted,
        },
        "Messages filtered after trusted data evaluation",
      );

      // Determine if TOON compression should be applied
      let toonTokensBefore: number | null = null;
      let toonTokensAfter: number | null = null;
      let toonCostSavings: number | null = null;
      const shouldApplyToonCompression =
        await utils.toonConversion.shouldApplyToonCompression(resolvedAgentId);

      if (shouldApplyToonCompression) {
        const { messages: convertedMessages, stats } =
          await utils.adapters.anthropic.convertToolResultsToToon(
            filteredMessages,
            model,
          );
        filteredMessages = convertedMessages;
        toonTokensBefore = stats.toonTokensBefore;
        toonTokensAfter = stats.toonTokensAfter;
        toonCostSavings = stats.toonCostSavings;
      }

      fastify.log.info(
        {
          shouldApplyToonCompression,
          toonTokensBefore,
          toonTokensAfter,
          toonCostSavings,
        },
        "anthropic proxy routes: handle messages: tool results compression completed",
      );

      if (stream) {
        logger.debug(
          { model, mergedToolsCount: mergedTools.length },
          "[AnthropicProxy] Starting streaming request",
        );
        // Track timing for TTFT and tokens/sec metrics
        const streamStartTime = Date.now();
        let firstChunkTime: number | undefined;

        // Handle streaming response with span to measure LLM call duration
        const messageStream = await utils.tracing.startActiveLlmSpan(
          "anthropic.messages",
          "anthropic",
          model,
          true,
          resolvedAgent,
          async (llmSpan) => {
            const stream = anthropicClient.messages.stream({
              // biome-ignore lint/suspicious/noExplicitAny: Anthropic still WIP
              ...(body as any),
              messages: filteredMessages,
              tools: mergedTools.length > 0 ? mergedTools : undefined,
            });
            llmSpan.end();
            return stream;
          },
        );

        // Accumulate tool calls and track content for persistence
        let accumulatedText = "";
        const accumulatedToolCalls: AnthropicProvider.Messages.ToolUseBlock[] =
          [];
        const events: AnthropicProvider.Messages.MessageStreamEvent[] = [];

        // Track indices of tool use blocks to know which content_block_stop events to skip
        const toolUseBlockIndices = new Set<number>();

        // Variables for interaction recording (accessible in finally block)
        let responseContent:
          | AnthropicProvider.Messages.ContentBlock[]
          | undefined;
        let messageStartEvent:
          | AnthropicProvider.Messages.MessageStartEvent
          | undefined;

        try {
          for await (const event of messageStream) {
            // Capture time to first token on first event
            if (!firstChunkTime) {
              firstChunkTime = Date.now();
              const ttftSeconds = (firstChunkTime - streamStartTime) / 1000;
              reportTimeToFirstToken(
                "anthropic",
                resolvedAgent,
                model,
                ttftSeconds,
                externalAgentId,
              );
            }

            events.push(event);

            // Stream message_start event immediately (contains message metadata)
            if (event.type === "message_start") {
              fastify.log.info(
                { eventType: event.type },
                "Streaming message_start event",
              );
              reply.raw.write(
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              );
            }

            // Stream content_block_start for text blocks immediately
            if (
              event.type === "content_block_start" &&
              event.content_block.type === "text"
            ) {
              fastify.log.info(
                { eventType: event.type, index: event.index },
                "Streaming content_block_start (text)",
              );
              reply.raw.write(
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              );
            }

            // Stream text content immediately
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              reply.raw.write(
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              );
              accumulatedText += event.delta.text;
            }

            // Stream content_block_stop for text blocks immediately (skip tool blocks)
            if (event.type === "content_block_stop") {
              if (!toolUseBlockIndices.has(event.index)) {
                fastify.log.info(
                  { eventType: event.type, index: event.index },
                  "Streaming content_block_stop (text)",
                );
                reply.raw.write(
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                );
              } else {
                fastify.log.info(
                  { eventType: event.type, index: event.index },
                  "Skipping content_block_stop (tool_use)",
                );
              }
            }

            // Accumulate tool calls (don't stream yet - need to evaluate policies first)
            if (
              event.type === "content_block_start" &&
              event.content_block.type === "tool_use"
            ) {
              toolUseBlockIndices.add(event.index);
              // Fix: Initialize input as empty string to avoid [object Object] concatenation bug
              // Anthropic's API sends input as {} initially, but we need a string for delta accumulation
              const toolCall = { ...event.content_block, input: "" };
              accumulatedToolCalls.push(toolCall);
              fastify.log.info(
                { eventType: event.type, index: event.index },
                "Accumulating content_block_start (tool_use)",
              );
            } else if (
              event.type === "content_block_delta" &&
              event.delta.type === "input_json_delta"
            ) {
              // Accumulate tool input JSON
              const lastToolCall =
                accumulatedToolCalls[accumulatedToolCalls.length - 1];
              if (lastToolCall) {
                lastToolCall.input =
                  (lastToolCall.input || "") + event.delta.partial_json;
              }
            }
          }

          fastify.log.info("Stream loop completed, processing final events");

          // Parse accumulated tool inputs
          for (const toolCall of accumulatedToolCalls) {
            try {
              toolCall.input = JSON.parse(toolCall.input as string);
            } catch {
              // If parsing fails, leave as string
            }
          }

          // Evaluate tool invocation policies dynamically
          let toolInvocationRefusal: [string, string] | null = null;
          if (accumulatedToolCalls.length > 0) {
            fastify.log.info(
              {
                toolCallCount: accumulatedToolCalls.length,
                toolNames: accumulatedToolCalls.map((tc) => tc.name),
              },
              "Evaluating tool invocation policies",
            );
            toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
              accumulatedToolCalls.map((toolCall) => ({
                toolCallName: toolCall.name,
                toolCallArgs: JSON.stringify(toolCall.input),
              })),
              resolvedAgentId,
              contextIsTrusted,
            );
            fastify.log.info(
              { refused: !!toolInvocationRefusal },
              "Tool invocation policy result",
            );
          }

          // Build the final response for persistence

          if (toolInvocationRefusal) {
            const [_refusalMessage, contentMessage] = toolInvocationRefusal;
            responseContent = [
              {
                type: "text",
                text: contentMessage,
                citations: null,
              },
            ];

            // Stream the refusal - must send content_block_start before delta
            const startEvent = {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "text",
                text: "",
              },
            };
            reply.raw.write(
              `event: content_block_start\ndata: ${JSON.stringify(
                startEvent,
              )}\n\n`,
            );

            const refusalEvent = {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: contentMessage,
              },
            };
            reply.raw.write(
              `event: content_block_delta\ndata: ${JSON.stringify(
                refusalEvent,
              )}\n\n`,
            );

            const stopEvent = {
              type: "content_block_stop",
              index: 0,
            };
            reply.raw.write(
              `event: content_block_stop\ndata: ${JSON.stringify(
                stopEvent,
              )}\n\n`,
            );
            reportBlockedTools(
              "anthropic",
              resolvedAgent,
              accumulatedToolCalls.length,
              model,
              externalAgentId,
            );
          } else {
            // Tool calls are allowed - stream them now
            if (accumulatedToolCalls.length > 0) {
              fastify.log.info(
                { toolCallCount: accumulatedToolCalls.length },
                "Tool calls allowed, streaming them now",
              );
              responseContent = [
                ...(accumulatedText
                  ? [
                      {
                        type: "text" as const,
                        text: accumulatedText,
                        citations: null,
                      },
                    ]
                  : []),
                ...accumulatedToolCalls,
              ];

              let streamedToolEvents = 0;
              for (const event of events) {
                if (
                  event.type === "content_block_start" &&
                  event.content_block.type === "tool_use"
                ) {
                  reply.raw.write(
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                  );
                  streamedToolEvents++;
                } else if (
                  event.type === "content_block_delta" &&
                  event.delta.type === "input_json_delta"
                ) {
                  reply.raw.write(
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                  );
                  streamedToolEvents++;
                } else if (
                  event.type === "content_block_stop" &&
                  toolUseBlockIndices.has(event.index)
                ) {
                  // Stream content_block_stop for tool_use blocks
                  reply.raw.write(
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                  );
                  streamedToolEvents++;
                }
              }
              fastify.log.info(
                { streamedToolEvents },
                "Streamed tool call events",
              );
            } else {
              responseContent = [
                {
                  type: "text",
                  text: accumulatedText,
                  citations: null,
                },
              ];
            }
          }

          // Get the message ID and other metadata from the stream
          messageStartEvent = events.find((e) => e.type === "message_start") as
            | AnthropicProvider.Messages.MessageStartEvent
            | undefined;

          // Send message_delta with stop_reason and usage
          const messageDeltaEvent = {
            type: "message_delta",
            delta: {
              stop_reason: "end_turn",
              stop_sequence: null,
            },
            usage: {
              output_tokens:
                messageStartEvent?.message.usage?.output_tokens || 0,
            },
          };
          fastify.log.info("Streaming message_delta event");
          reply.raw.write(
            `event: message_delta\ndata: ${JSON.stringify(
              messageDeltaEvent,
            )}\n\n`,
          );
          1;

          // Send message_stop event
          const messageStopEvent = {
            type: "message_stop",
          };
          fastify.log.info("Streaming message_stop event");
          reply.raw.write(
            `event: message_stop\ndata: ${JSON.stringify(messageStopEvent)}\n\n`,
          );

          fastify.log.info("Stream complete, ending response");
          reply.raw.end();
          return reply;
        } finally {
          // Always record interaction (whether stream completed or was aborted)
          if (messageStartEvent?.message.usage) {
            // If responseContent wasn't built (stream aborted), build it from accumulated data
            if (!responseContent) {
              fastify.log.info(
                "Stream was aborted before completion, building partial response",
              );

              // Parse accumulated tool inputs
              for (const toolCall of accumulatedToolCalls) {
                try {
                  toolCall.input = JSON.parse(toolCall.input as string);
                } catch {
                  // If parsing fails, leave as string
                }
              }

              // Build response content from what we have so far
              responseContent =
                accumulatedToolCalls.length > 0
                  ? [
                      ...(accumulatedText
                        ? [
                            {
                              type: "text" as const,
                              text: accumulatedText,
                              citations: null,
                            },
                          ]
                        : []),
                      ...accumulatedToolCalls,
                    ]
                  : [
                      {
                        type: "text" as const,
                        text: accumulatedText,
                        citations: null,
                      },
                    ];
            }

            // Extract token usage and calculate costs
            const usage = messageStartEvent.message.usage;
            const tokenUsage = utils.adapters.anthropic.getUsageTokens(usage);

            if (messageStartEvent.message.usage) {
              reportLLMTokens(
                "anthropic",
                resolvedAgent,
                tokenUsage,
                model,
                externalAgentId,
              );

              // Report tokens per second if we have output tokens and timing
              if (tokenUsage.output && firstChunkTime) {
                const totalDurationSeconds =
                  (Date.now() - streamStartTime) / 1000;
                reportTokensPerSecond(
                  "anthropic",
                  resolvedAgent,
                  model,
                  tokenUsage.output,
                  totalDurationSeconds,
                  externalAgentId,
                );
              }
            }

            const baselineCost = await utils.costOptimization.calculateCost(
              body.model,
              tokenUsage.input,
              tokenUsage.output,
            );
            const costAfterModelOptimization =
              await utils.costOptimization.calculateCost(
                model,
                tokenUsage.input,
                tokenUsage.output,
              );

            fastify.log.info(
              {
                model: model,
                baselineModel: body.model,
                baselineCost: baselineCost,
                costAfterModelOptimization: costAfterModelOptimization,
                inputTokens: tokenUsage.input,
                outputTokens: tokenUsage.output,
              },
              "anthropic proxy routes: handle messages: costs",
            );
            reportLLMCost(
              "anthropic",
              resolvedAgent,
              model,
              costAfterModelOptimization,
              externalAgentId,
            );

            // Record the interaction
            await InteractionModel.create({
              profileId: resolvedAgentId,
              externalAgentId,
              userId,
              type: "anthropic:messages",
              request: body,
              processedRequest: {
                ...body,
                messages: filteredMessages,
              },
              response: {
                id: messageStartEvent.message.id,
                type: "message",
                role: "assistant",
                content: responseContent,
                model: model,
                stop_reason: "end_turn",
                stop_sequence: null,
                usage,
              },
              model: model,
              inputTokens: tokenUsage.input,
              outputTokens: tokenUsage.output,
              cost: costAfterModelOptimization?.toFixed(10) ?? null,
              baselineCost: baselineCost?.toFixed(10) ?? null,
              toonTokensBefore,
              toonTokensAfter,
              toonCostSavings: toonCostSavings?.toFixed(10) ?? null,
            });
          }
        }
      } else {
        logger.debug(
          { model, mergedToolsCount: mergedTools.length },
          "[AnthropicProxy] Starting non-streaming request",
        );
        // Non-streaming response with span to measure LLM call duration
        const response = await utils.tracing.startActiveLlmSpan(
          "anthropic.messages",
          "anthropic",
          model,
          false,
          resolvedAgent,
          async (llmSpan) => {
            const response = await anthropicClient.messages.create({
              // biome-ignore lint/suspicious/noExplicitAny: Anthropic still WIP
              ...(body as any),
              messages: filteredMessages,
              tools: mergedTools.length > 0 ? mergedTools : undefined,
              stream: false,
            });
            llmSpan.end();
            return response;
          },
        );

        const toolCalls = response.content.filter(
          (content) => content.type === "tool_use",
        );

        logger.debug(
          { toolCallCount: toolCalls.length },
          "[AnthropicProxy] Non-streaming response received, checking tool invocation policies",
        );

        if (toolCalls) {
          const toolInvocationRefusal =
            await utils.toolInvocation.evaluatePolicies(
              toolCalls.map((toolCall) => ({
                toolCallName: toolCall.name,
                toolCallArgs: JSON.stringify(toolCall.input),
              })),
              resolvedAgentId,
              contextIsTrusted,
            );

          if (toolInvocationRefusal) {
            const [_refusalMessage, contentMessage] = toolInvocationRefusal;
            logger.debug(
              { toolCallCount: toolCalls.length },
              "[AnthropicProxy] Tool invocation blocked by policy",
            );
            response.content = [
              {
                type: "text",
                text: contentMessage,
                citations: null,
              },
            ];

            reportBlockedTools(
              "anthropic",
              resolvedAgent,
              toolCalls.length,
              model,
              externalAgentId,
            );

            // Extract token usage and store the interaction with refusal
            const tokenUsage = response.usage
              ? utils.adapters.anthropic.getUsageTokens(response.usage)
              : { input: null, output: null };

            // Always calculate baseline cost (original requested model)
            const baselineCost = await utils.costOptimization.calculateCost(
              body.model,
              tokenUsage.input,
              tokenUsage.output,
            );
            const costAfterModelOptimization =
              await utils.costOptimization.calculateCost(
                model,
                tokenUsage.input,
                tokenUsage.output,
              );
            reportLLMCost(
              "anthropic",
              resolvedAgent,
              model,
              costAfterModelOptimization,
              externalAgentId,
            );

            await InteractionModel.create({
              profileId: resolvedAgentId,
              externalAgentId,
              userId,
              type: "anthropic:messages",
              request: body,
              processedRequest: {
                ...body,
                messages: filteredMessages,
              },
              response: response,
              model: model,
              inputTokens: tokenUsage.input,
              outputTokens: tokenUsage.output,
              cost: costAfterModelOptimization?.toFixed(10) ?? null,
              baselineCost: baselineCost?.toFixed(10) ?? null,
              toonTokensBefore,
              toonTokensAfter,
              toonCostSavings: toonCostSavings?.toFixed(10) ?? null,
            });

            return reply.send(response);
          }
          // Tool calls are allowed - return response with tool_use blocks to client
          // Client is responsible for executing tools via MCP Gateway and sending results back
        }

        // Extract token usage and store the complete interaction
        const tokenUsageFinal = response.usage
          ? utils.adapters.anthropic.getUsageTokens(response.usage)
          : { input: null, output: null };

        // Calculate costs using database pricing (TokenPriceModel)
        // Always calculate costs for proper TOON compression tracking
        const baselineCostFinal = await utils.costOptimization.calculateCost(
          body.model,
          tokenUsageFinal.input,
          tokenUsageFinal.output,
        );

        // Calculate actual cost (potentially optimized model)
        const costAfterModelOptimizationFinal =
          await utils.costOptimization.calculateCost(
            model,
            tokenUsageFinal.input,
            tokenUsageFinal.output,
          );
        reportLLMCost(
          "anthropic",
          resolvedAgent,
          model,
          costAfterModelOptimizationFinal,
          externalAgentId,
        );

        await InteractionModel.create({
          profileId: resolvedAgentId,
          externalAgentId,
          userId,
          type: "anthropic:messages",
          request: body,
          processedRequest: {
            ...body,
            messages: filteredMessages,
          },
          response: response,
          model: model,
          inputTokens: tokenUsageFinal.input,
          outputTokens: tokenUsageFinal.output,
          cost: costAfterModelOptimizationFinal?.toFixed(10) ?? null,
          baselineCost: baselineCostFinal?.toFixed(10) ?? null,
          toonTokensBefore,
          toonTokensAfter,
          toonCostSavings: toonCostSavings?.toFixed(10) ?? null,
        });

        return reply.send(response);
      }
    } catch (error) {
      fastify.log.error(error);

      const statusCode =
        error instanceof Error && "status" in error
          ? (error.status as 200 | 400 | 404 | 403 | 500)
          : 500;

      // Extract the actual error message from Anthropic SDK errors using lodash get
      // Anthropic errors have structure: { error: { error: { message: "..." } } }
      const getErrorMessage = (err: unknown): string => {
        // Try to extract from triple-nested path
        const anthropicMessage = get(err, "error.error.message");
        if (typeof anthropicMessage === "string") {
          fastify.log.info(
            { extractedMessage: anthropicMessage },
            "Successfully extracted Anthropic error message",
          );
          return anthropicMessage;
        }

        if (err instanceof Error) {
          fastify.log.info(
            { message: err.message },
            "Using Error.message fallback",
          );
          return err.message;
        }
        return "Internal server error";
      };

      const errorMessage = getErrorMessage(error);

      // Check if we're streaming
      if (stream) {
        // For streaming responses, send error as SSE event (even if headers not sent yet)
        const errorEvent = {
          type: "error",
          error: {
            type: "api_error",
            message: errorMessage,
          },
        };

        if (reply.sent) {
          // Headers already sent, write to stream
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`,
          );
          reply.raw.end();
        } else {
          // Headers not sent yet, send as SSE format string with 200 status
          // (streaming responses need 200 OK, error is in the stream content)
          const sseError = `event: error\ndata: ${JSON.stringify(
            errorEvent,
          )}\n\n`;
          return reply.status(200).send(sseError);
        }
        return reply;
      }

      // For non-streaming, send JSON error
      return reply.status(statusCode).send({
        error: {
          message: errorMessage,
          type: "api_error",
        },
      });
    }
  };

  /**
   * Anthropic SDK standard format (with /v1 prefix)
   * No agentId is provided -- agent is created/fetched based on the user-agent header
   */
  fastify.post(
    `${API_PREFIX}/v1${MESSAGES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AnthropicMessagesWithDefaultAgent,
        description: "Send a message to Anthropic using the default agent",
        tags: ["llm-proxy"],
        body: Anthropic.API.MessagesRequestSchema,
        headers: Anthropic.API.MessagesHeadersSchema,
        response: constructResponseSchema(Anthropic.API.MessagesResponseSchema),
      },
    },
    async (request, reply) => {
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleMessages(
        request.body,
        request.headers,
        reply,
        request.organizationId,
        undefined,
        externalAgentId,
        userId,
      );
    },
  );

  /**
   * Anthropic SDK standard format (with /v1 prefix)
   * An agentId is provided -- agent is fetched based on the agentId
   *
   * NOTE: this is really only needed for n8n compatibility...
   */
  fastify.post(
    `${API_PREFIX}/:agentId/v1${MESSAGES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AnthropicMessagesWithAgent,
        description:
          "Send a message to Anthropic using a specific agent (n8n URL format)",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Anthropic.API.MessagesRequestSchema,
        headers: Anthropic.API.MessagesHeadersSchema,
        response: constructResponseSchema(Anthropic.API.MessagesResponseSchema),
      },
    },
    async (request, reply) => {
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleMessages(
        request.body,
        request.headers,
        reply,
        request.organizationId,
        request.params.agentId,
        externalAgentId,
        userId,
      );
    },
  );
};

export default anthropicProxyRoutes;
