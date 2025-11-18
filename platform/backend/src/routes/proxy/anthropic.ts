import AnthropicProvider from "@anthropic-ai/sdk";
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { get } from "lodash-es";
import { z } from "zod";
import config from "@/config";
import {
  getObservableFetch,
  reportBlockedTools,
  reportLLMTokens,
} from "@/llm-metrics";
import { AgentModel, InteractionModel, LimitValidationService } from "@/models";
import {
  type Agent,
  Anthropic,
  constructResponseSchema,
  UuidIdSchema,
} from "@/types";
import { PROXY_API_PREFIX } from "./common";
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
    agentId?: string,
  ) => {
    const { tools, stream } = body;

    fastify.log.info(
      {
        agentId,
        model: body.model,
        stream,
        messagesCount: body.messages.length,
        toolsCount: tools?.length || 0,
        maxTokens: body.max_tokens,
      },
      "Anthropic messages request received",
    );

    // Debug: Log message structure
    if (body.messages.length > 0) {
      fastify.log.info(
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
        "Message structure debug",
      );
    }

    let resolvedAgent: Agent;
    if (agentId) {
      // If agentId provided via URL, validate it exists
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
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
      resolvedAgent = await AgentModel.getAgentOrCreateDefault(
        headers["user-agent"],
      );
    }

    const resolvedAgentId = resolvedAgent.id;

    fastify.log.info(
      { resolvedAgentId, wasExplicit: !!agentId },
      "Agent resolved",
    );

    const { "x-api-key": anthropicApiKey } = headers;

    const anthropicClient = config.benchmark.mockMode
      ? (new MockAnthropicClient() as unknown as AnthropicProvider)
      : new AnthropicProvider({
          apiKey: anthropicApiKey,
          baseURL: config.llm.anthropic.baseUrl,
          fetch: getObservableFetch("anthropic", resolvedAgent),
        });

    try {
      // Check if current usage limits are already exceeded
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

      // Persist non-MCP tools declared by client for tracking
      if (tools) {
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
      // Optimize model selection for cost if enabled using dynamic rules
      if (resolvedAgent.optimizeCost) {
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
      }

      // Convert to common format and evaluate trusted data policies
      const commonMessages = utils.adapters.anthropic.toCommonFormat(
        body.messages,
      );

      // For streaming requests, set headers first
      if (stream) {
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
                  `event: content_block_delta\ndata: ${JSON.stringify(startEvent)}\n\n`,
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
                  `event: content_block_delta\ndata: ${JSON.stringify(progressEvent)}\n\n`,
                );
              }
            : undefined,
        );

      // Apply updates back to Anthropic messages
      const filteredMessages = utils.adapters.anthropic.applyUpdates(
        body.messages,
        toolResultUpdates,
      );

      fastify.log.info(
        {
          resolvedAgentId,
          originalMessagesCount: body.messages.length,
          filteredMessagesCount: filteredMessages.length,
          toolResultUpdatesCount: toolResultUpdates.length,
        },
        "Messages filtered after trusted data evaluation",
      );

      if (stream) {
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

        for await (const event of messageStream) {
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
            accumulatedToolCalls.push(event.content_block);
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
        let responseContent: AnthropicProvider.Messages.ContentBlock[];

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
            `event: content_block_start\ndata: ${JSON.stringify(startEvent)}\n\n`,
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
            `event: content_block_delta\ndata: ${JSON.stringify(refusalEvent)}\n\n`,
          );

          const stopEvent = {
            type: "content_block_stop",
            index: 0,
          };
          reply.raw.write(
            `event: content_block_stop\ndata: ${JSON.stringify(stopEvent)}\n\n`,
          );
          reportBlockedTools(
            "anthropic",
            resolvedAgent,
            accumulatedToolCalls.length,
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
        const messageStartEvent = events.find(
          (e) => e.type === "message_start",
        ) as AnthropicProvider.Messages.MessageStartEvent | undefined;

        // Extract token usage and report metrics for streaming
        const usage = messageStartEvent?.message.usage || {
          input_tokens: 0,
          output_tokens: 0,
        };
        const tokenUsage = utils.adapters.anthropic.getUsageTokens(usage);

        if (messageStartEvent?.message.usage) {
          reportLLMTokens("anthropic", resolvedAgent, tokenUsage);
        }

        // Only calculate costs if cost optimization is enabled
        let cost: number | undefined;
        let baselineCost: number | undefined;

        if (resolvedAgent.optimizeCost) {
          cost = await utils.costOptimization.calculateCost(
            model,
            tokenUsage.input,
            tokenUsage.output,
          );
          baselineCost = await utils.costOptimization.calculateCost(
            body.model,
            tokenUsage.input,
            tokenUsage.output,
          );
        }

        // Store the complete interaction
        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "anthropic:messages",
          request: body,
          response: {
            id: messageStartEvent?.message.id || "msg-unknown",
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
          cost: cost?.toFixed(10) ?? null,
          baselineCost: baselineCost?.toFixed(10) ?? null,
        });

        // Send message_delta with stop_reason and usage
        const messageDeltaEvent = {
          type: "message_delta",
          delta: {
            stop_reason: "end_turn",
            stop_sequence: null,
          },
          usage: {
            output_tokens: usage.output_tokens,
          },
        };
        fastify.log.info("Streaming message_delta event");
        reply.raw.write(
          `event: message_delta\ndata: ${JSON.stringify(messageDeltaEvent)}\n\n`,
        );

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
      } else {
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
            response.content = [
              {
                type: "text",
                text: contentMessage,
                citations: null,
              },
            ];

            reportBlockedTools("anthropic", resolvedAgent, toolCalls.length);

            // Extract token usage and store the interaction with refusal
            const tokenUsage = response.usage
              ? utils.adapters.anthropic.getUsageTokens(response.usage)
              : { input: null, output: null };

            // Only calculate costs if cost optimization is enabled
            let cost: number | undefined;
            let baselineCost: number | undefined;

            if (resolvedAgent.optimizeCost) {
              cost = await utils.costOptimization.calculateCost(
                model,
                tokenUsage.input,
                tokenUsage.output,
              );
              baselineCost = await utils.costOptimization.calculateCost(
                body.model,
                tokenUsage.input,
                tokenUsage.output,
              );
            }

            await InteractionModel.create({
              agentId: resolvedAgentId,
              type: "anthropic:messages",
              request: body,
              response: response,
              model: model,
              inputTokens: tokenUsage.input,
              outputTokens: tokenUsage.output,
              cost: cost?.toFixed(10) ?? null,
              baselineCost: baselineCost?.toFixed(10) ?? null,
            });

            return reply.send(response);
          }
          // Tool calls are allowed - return response with tool_use blocks to client
          // Client is responsible for executing tools via MCP Gateway and sending results back
        }

        // Extract token usage and store the complete interaction
        const tokenUsage = response.usage
          ? utils.adapters.anthropic.getUsageTokens(response.usage)
          : { input: null, output: null };

        // Calculate costs using database pricing (TokenPriceModel)
        // Only calculate costs if cost optimization is enabled
        let cost: number | undefined;
        let baselineCost: number | undefined;

        if (resolvedAgent.optimizeCost) {
          cost = await utils.costOptimization.calculateCost(
            model,
            tokenUsage.input,
            tokenUsage.output,
          );
          baselineCost = await utils.costOptimization.calculateCost(
            body.model,
            tokenUsage.input,
            tokenUsage.output,
          );
        }

        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "anthropic:messages",
          request: body,
          response: response,
          model: model,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
          cost: cost?.toFixed(10) ?? null,
          baselineCost: baselineCost?.toFixed(10) ?? null,
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
          const sseError = `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`;
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
      schema: {
        operationId: RouteId.AnthropicMessagesWithDefaultAgent,
        description: "Send a message to Anthropic using the default agent",
        tags: ["llm-proxy"],
        body: Anthropic.API.MessagesRequestSchema,
        headers: Anthropic.API.MessagesHeadersSchema,
        response: constructResponseSchema(Anthropic.API.MessagesResponseSchema),
      },
    },
    async ({ body, headers }, reply) => {
      return handleMessages(body, headers, reply);
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
    async ({ body, headers, params }, reply) => {
      return handleMessages(body, headers, reply, params.agentId);
    },
  );
};

export default anthropicProxyRoutes;
