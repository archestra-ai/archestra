import AnthropicProvider from "@anthropic-ai/sdk";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { getObservableFetch, reportLLMTokens } from "@/llm-metrics";
import { AgentModel, InteractionModel } from "@/models";
import LimitValidationService from "@/services/limit-validation";
import {
  type Agent,
  Anthropic,
  ErrorResponseSchema,
  RouteId,
  UuidIdSchema,
} from "@/types";
import { PROXY_API_PREFIX } from "./common";
import * as utils from "./utils";

/**
 * Inject assigned MCP tools into Anthropic tools array
 * Assigned tools take priority and override tools with the same name from the request
 */
export const injectTools = async (
  requestTools: z.infer<typeof Anthropic.Tools.ToolSchema>[] | undefined,
  agentId: string,
): Promise<z.infer<typeof Anthropic.Tools.ToolSchema>[]> => {
  const assignedTools = await utils.tools.getAssignedMCPTools(agentId);

  // Convert assigned tools to Anthropic format (CustomTool)
  const assignedAnthropicTools: z.infer<
    typeof Anthropic.Tools.CustomToolSchema
  >[] = assignedTools.map((tool) => ({
    name: tool.name,
    description: tool.description || undefined,
    input_schema: tool.parameters || {},
    type: "custom" as const,
  }));

  // Create a map of request tools by name
  const requestToolMap = new Map<
    string,
    z.infer<typeof Anthropic.Tools.ToolSchema>
  >();
  for (const tool of requestTools || []) {
    requestToolMap.set(tool.name, tool);
  }

  // Merge: assigned tools override request tools with same name
  const mergedToolMap = new Map<
    string,
    z.infer<typeof Anthropic.Tools.ToolSchema>
  >(requestToolMap);
  for (const assignedTool of assignedAnthropicTools) {
    mergedToolMap.set(assignedTool.name, assignedTool);
  }

  return Array.from(mergedToolMap.values());
};

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

    const anthropicClient = new AnthropicProvider({
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

      if (tools) {
        const transformedTools: Parameters<typeof utils.tools.persistTools>[0] =
          [];

        for (const tool of tools) {
          // null/undefine/type === custom essentially all mean the same thing for Anthropic tools...
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

      // TODO: Injection is disabled as we connect only with mcp serverInject assigned MCP tools (assigned tools take priority)
      const mergedTools = await injectTools(tools, resolvedAgentId);
      // const mergedTools = tools || [];

      fastify.log.info(
        {
          resolvedAgentId,
          requestToolsCount: tools?.length || 0,
          mergedToolsCount: mergedTools.length,
          mcpToolsInjected: mergedTools.length - (tools?.length || 0),
        },
        "MCP tools injected",
      );

      // Convert to common format and evaluate trusted data policies
      const commonMessages = utils.adapters.anthropic.toCommonFormat(
        body.messages,
      );

      // For streaming requests, set headers first
      if (stream) {
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-cache");
        reply.header("Connection", "keep-alive");
      }

      const { toolResultUpdates, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonMessages,
          resolvedAgentId,
          anthropicApiKey,
          "anthropic",
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
          body.model,
          true,
          resolvedAgent,
          async (llmSpan) => {
            const stream = anthropicClient.messages.stream({
              // biome-ignore lint/suspicious/noExplicitAny: Anthropic still WIP
              ...(body as any),
              messages: filteredMessages,
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

        for await (const event of messageStream) {
          events.push(event);

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

          // Accumulate tool calls (don't stream yet - need to evaluate policies first)
          if (
            event.type === "content_block_start" &&
            event.content_block.type === "tool_use"
          ) {
            accumulatedToolCalls.push(event.content_block);
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
          toolInvocationRefusal = await utils.toolInvocation.evaluatePolicies(
            accumulatedToolCalls.map((toolCall) => ({
              toolCallName: toolCall.name,
              toolCallArgs: JSON.stringify(toolCall.input),
            })),
            resolvedAgentId,
            contextIsTrusted,
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

          // Stream the refusal
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
        } else {
          // Tool calls are allowed - stream them now
          if (accumulatedToolCalls.length > 0) {
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

            for (const event of events) {
              if (
                event.type === "content_block_start" &&
                event.content_block.type === "tool_use"
              ) {
                reply.raw.write(
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                );
              } else if (
                event.type === "content_block_delta" &&
                event.delta.type === "input_json_delta"
              ) {
                reply.raw.write(
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                );
              }
            }
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
          reportLLMTokens(
            "anthropic",
            resolvedAgent,
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
            model: body.model,
            stop_reason: "end_turn",
            stop_sequence: null,
            usage,
          },
          model: body.model,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
        });

        // Send message_delta with stop_reason
        const messageDeltaEvent = {
          type: "message_delta",
          delta: {
            stop_reason: "end_turn",
            stop_sequence: null,
          },
        };
        reply.raw.write(
          `event: message_delta\ndata: ${JSON.stringify(messageDeltaEvent)}\n\n`,
        );

        // Send message_stop event
        reply.raw.write(`event: message_stop\ndata: {}\n\n`);

        reply.raw.end();
        return reply;
      } else {
        // Non-streaming response with span to measure LLM call duration
        let response = await utils.tracing.startActiveLlmSpan(
          "anthropic.messages",
          "anthropic",
          body.model,
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

            // Extract token usage and store the interaction with refusal
            const tokenUsage = response.usage
              ? utils.adapters.anthropic.getUsageTokens(response.usage)
              : { input: null, output: null };

            await InteractionModel.create({
              agentId: resolvedAgentId,
              type: "anthropic:messages",
              request: body,
              response: response,
              model: body.model,
              inputTokens: tokenUsage.input,
              outputTokens: tokenUsage.output,
            });

            return reply.send(response);
          } else if (toolCalls.length > 0) {
            // Tool calls are allowed - execute MCP tools
            const commonToolCalls = utils.adapters.anthropic.toolCallsToCommon(
              toolCalls as Array<{
                id: string;
                name: string;
                input: Record<string, unknown>;
              }>,
            );

            fastify.log.info(
              {
                resolvedAgentId,
                toolCalls: commonToolCalls.map((tc) => ({
                  id: tc.id,
                  name: tc.name,
                  argumentKeys: Object.keys(tc.arguments),
                })),
              },
              "Executing MCP tool calls (non-streaming)",
            );

            const mcpResults = await utils.tools.executeMcpToolCalls(
              commonToolCalls,
              resolvedAgentId,
            );

            fastify.log.info(
              {
                resolvedAgentId,
                results: mcpResults.map((r) => ({
                  id: r.id,
                  isError: r.isError,
                  contentLength:
                    typeof r.content === "string"
                      ? r.content.length
                      : JSON.stringify(r.content).length,
                })),
              },
              "MCP tool calls completed (non-streaming)",
            );

            if (mcpResults.length > 0) {
              // Convert MCP results to Anthropic tool result messages
              const toolResultMessages =
                utils.adapters.anthropic.toolResultsToMessages(mcpResults);

              // Make another call with the tool results
              const updatedMessages = [
                ...filteredMessages,
                {
                  role: "assistant" as const,
                  content: response.content,
                },
                ...toolResultMessages,
              ];

              // Make final call with tool results
              const finalResponse = await utils.tracing.startActiveLlmSpan(
                "anthropic.messages.continuation",
                "anthropic",
                body.model,
                false,
                resolvedAgent,
                async (continuationSpan) => {
                  continuationSpan.setAttribute("llm.continuation", true);
                  const response = await anthropicClient.messages.create({
                    // biome-ignore lint/suspicious/noExplicitAny: Anthropic still WIP
                    ...(body as any),
                    messages: updatedMessages,
                    tools: mergedTools.length > 0 ? mergedTools : undefined,
                    stream: false,
                  });
                  continuationSpan.end();
                  return response;
                },
              );

              // Update the response with the final LLM response
              response = finalResponse;
            }
          }
        }

        // Extract token usage and store the complete interaction
        const tokenUsage = response.usage
          ? utils.adapters.anthropic.getUsageTokens(response.usage)
          : { input: null, output: null };

        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "anthropic:messages",
          request: body,
          response: response,
          model: body.model,
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
        });

        return reply.send(response);
      }
    } catch (error) {
      fastify.log.error(error);

      const statusCode =
        error instanceof Error && "status" in error
          ? (error.status as 200 | 400 | 404 | 403 | 500)
          : 500;

      return reply.status(statusCode).send({
        error: {
          message:
            error instanceof Error ? error.message : "Internal server error",
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
        response: {
          200: Anthropic.API.MessagesResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
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
        response: {
          200: Anthropic.API.MessagesResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body, headers, params }, reply) => {
      return handleMessages(body, headers, reply, params.agentId);
    },
  );
};

export default anthropicProxyRoutes;
