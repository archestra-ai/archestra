import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import OpenAIProvider from "openai";
import { z } from "zod";
import config from "@/config";
import { getObservableFetch, reportLLMTokens } from "@/llm-metrics";
import { AgentModel, InteractionModel } from "@/models";
import LimitValidationService from "@/services/limit-validation";
import {
  type Agent,
  ErrorResponseSchema,
  OpenAi,
  RouteId,
  UuidIdSchema,
} from "@/types";
import { PROXY_API_PREFIX } from "./common";
import { MockOpenAIClient } from "./mock-openai-client";
import * as utils from "./utils";

/**
 * Inject assigned MCP tools into OpenAI tools array
 * Assigned tools take priority and override tools with the same name from the request
 */
export const injectTools = async (
  requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] | undefined,
  agentId: string,
): Promise<z.infer<typeof OpenAi.Tools.ToolSchema>[]> => {
  const assignedTools = await utils.tools.getAssignedMCPTools(agentId);

  // Convert assigned tools to OpenAI format
  const assignedOpenAITools: z.infer<typeof OpenAi.Tools.ToolSchema>[] =
    assignedTools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description || undefined,
        parameters: tool.parameters,
      },
    }));

  // Create a map of request tools by name for easy lookup
  const requestToolMap = new Map<
    string,
    z.infer<typeof OpenAi.Tools.ToolSchema>
  >();
  for (const tool of requestTools || []) {
    const toolName =
      tool.type === "function" ? tool.function.name : tool.custom.name;
    requestToolMap.set(toolName, tool);
  }

  // Merge: assigned tools override request tools with same name
  const mergedToolMap = new Map<
    string,
    z.infer<typeof OpenAi.Tools.ToolSchema>
  >(requestToolMap);
  for (const assignedTool of assignedOpenAITools) {
    // All assigned tools are function type since we create them that way above
    if (assignedTool.type === "function") {
      mergedToolMap.set(assignedTool.function.name, assignedTool);
    }
  }

  return Array.from(mergedToolMap.values());
};

const openAiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/openai`;
  const CHAT_COMPLETIONS_SUFFIX = "chat/completions";

  /**
   * Register HTTP proxy for OpenAI routes
   * Handles both patterns:
   * - /v1/openai/:agentId/* -> config.llm.openai.baseUrl/* (agentId stripped if UUID)
   *  - /v1/openai/* -> config.llm.openai.baseUrl/* (direct proxy)
   *
   * Chat completions are excluded and handled separately below with full agent support
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.openai.baseUrl,
    prefix: `${API_PREFIX}`,
    rewritePrefix: "",
    preHandler: (request, _reply, next) => {
      // Skip chat/completions (we handle it specially below with full agent support)
      if (
        request.method === "POST" &&
        request.url.includes(CHAT_COMPLETIONS_SUFFIX)
      ) {
        fastify.log.info(
          {
            method: request.method,
            url: request.url,
            action: "skip-proxy",
            reason: "handled-by-custom-handler",
          },
          "OpenAI proxy preHandler: skipping chat/completions route",
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
        // Strip UUID: /v1/openai/:uuid/path -> /v1/openai/path
        const remainingPath = uuidMatch[2] || "";
        const originalUrl = request.raw.url;
        request.raw.url = `${API_PREFIX}${remainingPath}`;

        fastify.log.info(
          {
            method: request.method,
            originalUrl,
            rewrittenUrl: request.raw.url,
            upstream: config.llm.openai.baseUrl,
            finalProxyUrl: `${config.llm.openai.baseUrl}/v1${remainingPath}`,
          },
          "OpenAI proxy preHandler: URL rewritten (UUID stripped)",
        );
      } else {
        fastify.log.info(
          {
            method: request.method,
            url: request.url,
            upstream: config.llm.openai.baseUrl,
            finalProxyUrl: `${config.llm.openai.baseUrl}/v1${pathAfterPrefix}`,
          },
          "OpenAI proxy preHandler: proxying request",
        );
      }

      next();
    },
  });

  const handleChatCompletion = async (
    body: OpenAi.Types.ChatCompletionsRequest,
    headers: OpenAi.Types.ChatCompletionsHeaders,
    reply: FastifyReply,
    agentId?: string,
  ) => {
    const { messages, tools, stream } = body;

    fastify.log.info(
      {
        agentId,
        model: body.model,
        stream,
        messagesCount: messages.length,
        toolsCount: tools?.length || 0,
        maxTokens: body.max_tokens,
      },
      "OpenAI chat completion request received",
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

    const { authorization: openAiApiKey } = headers;
    const openAiClient = config.benchmark.mockMode
      ? (new MockOpenAIClient() as unknown as OpenAIProvider)
      : new OpenAIProvider({
          apiKey: openAiApiKey,
          baseURL: config.llm.openai.baseUrl,
          fetch: getObservableFetch("openai", resolvedAgent),
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
          "OpenAI request blocked due to token cost limit",
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

      await utils.tools.persistTools(
        (tools || []).map((tool) => {
          if (tool.type === "function") {
            return {
              toolName: tool.function.name,
              toolParameters: tool.function.parameters || {},
              toolDescription: tool.function.description || "",
            };
          } else {
            return {
              toolName: tool.custom.name,
              toolParameters: tool.custom.format || {},
              toolDescription: tool.custom.description || "",
            };
          }
        }),
        resolvedAgentId,
      );

      // Inject assigned MCP tools (assigned tools take priority)
      const mergedTools = await injectTools(tools, resolvedAgentId);

      fastify.log.info(
        {
          resolvedAgentId,
          requestToolsCount: tools?.length || 0,
          mergedToolsCount: mergedTools.length,
          mcpToolsInjected: mergedTools.length - (tools?.length || 0),
          mergedTools: JSON.stringify(mergedTools),
        },
        "MCP tools injected",
      );

      // Convert to common format and evaluate trusted data policies
      const commonMessages = utils.adapters.openai.toCommonFormat(messages);

      const { toolResultUpdates, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonMessages,
          resolvedAgentId,
          openAiApiKey,
          "openai",
          stream
            ? () => {
                // Send initial indicator when dual LLM starts (streaming only)
                const startChunk = {
                  id: "chatcmpl-sanitizing",
                  object: "chat.completion.chunk" as const,
                  created: Date.now() / 1000,
                  model: body.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: "assistant" as const,
                        content: "Analyzing with Dual LLM:\n\n",
                      },
                      finish_reason: null,
                      logprobs: null,
                    },
                  ],
                };
                reply.raw.write(`data: ${JSON.stringify(startChunk)}\n\n`);
              }
            : undefined,
          stream
            ? (progress) => {
                // Stream Q&A progress with options
                const optionsText = progress.options
                  .map((opt, idx) => `  ${idx}: ${opt}`)
                  .join("\n");
                const progressChunk = {
                  id: "chatcmpl-sanitizing",
                  object: "chat.completion.chunk" as const,
                  created: Date.now() / 1000,
                  model: body.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: `Question: ${progress.question}\nOptions:\n${optionsText}\nAnswer: ${progress.answer}\n\n`,
                      },
                      finish_reason: null,
                      logprobs: null,
                    },
                  ],
                };
                reply.raw.write(`data: ${JSON.stringify(progressChunk)}\n\n`);
              }
            : undefined,
        );

      // Apply updates back to OpenAI messages
      const filteredMessages = utils.adapters.openai.applyUpdates(
        messages,
        toolResultUpdates,
      );

      fastify.log.info(
        {
          resolvedAgentId,
          originalMessagesCount: messages.length,
          filteredMessagesCount: filteredMessages.length,
          toolResultUpdatesCount: toolResultUpdates.length,
        },
        "Messages filtered after trusted data evaluation",
      );

      if (stream) {
        // Handle streaming response with span to measure LLM call duration
        const streamingResponse = await utils.tracing.startActiveLlmSpan(
          "openai.chat.completions",
          "openai",
          body.model,
          true,
          resolvedAgent,
          async (llmSpan) => {
            const response = await openAiClient.chat.completions.create({
              ...body,
              messages: filteredMessages,
              tools: mergedTools.length > 0 ? mergedTools : undefined,
              stream: true,
              stream_options: { include_usage: true },
            });
            llmSpan.end();
            return response;
          },
        );

        // We are using reply.raw.writeHead because it sets headers immediately before the streaming starts
        // unlike reply.header(key, value) which will set headers too late, after the streaming is over.
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
        });

        // Accumulate tool calls and track content for persistence
        let accumulatedContent = "";
        let accumulatedRefusal = "";
        const accumulatedToolCalls: OpenAIProvider.Chat.Completions.ChatCompletionMessageFunctionToolCall[] =
          [];
        const chunks: OpenAIProvider.Chat.Completions.ChatCompletionChunk[] =
          [];
        let usageTokens: { input?: number; output?: number } | undefined;

        for await (const chunk of streamingResponse) {
          chunks.push(chunk);

          // Capture usage information if present
          if (chunk.usage) {
            usageTokens = utils.adapters.openai.getUsageTokens(chunk.usage);
          }
          const delta = chunk.choices[0]?.delta;
          const finishReason = chunk.choices[0]?.finish_reason;

          // Stream text content immediately. Also stream first chunk with role. And last chunk with finish reason.
          // But DON'T stream chunks with tool_calls - we'll send those later after policy evaluation
          if (
            !delta?.tool_calls &&
            (delta?.content !== undefined ||
              delta?.refusal !== undefined ||
              delta?.role ||
              finishReason)
          ) {
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);

            // Also accumulate for persistence
            if (delta?.content) {
              accumulatedContent += delta.content;
            }
            if (delta?.refusal) {
              accumulatedRefusal += delta.refusal;
            }
          }

          // Accumulate tool calls (don't stream yet - need to evaluate policies first)
          if (delta?.tool_calls) {
            for (const toolCallDelta of delta.tool_calls) {
              const index = toolCallDelta.index;

              // Initialize tool call if it doesn't exist
              if (!accumulatedToolCalls[index]) {
                accumulatedToolCalls[index] = {
                  id: toolCallDelta.id || "",
                  type: "function",
                  function: {
                    name: "",
                    arguments: "",
                  },
                };
              }

              // Accumulate tool call fields
              if (toolCallDelta.id) {
                accumulatedToolCalls[index].id = toolCallDelta.id;
              }
              if (toolCallDelta.function?.name) {
                accumulatedToolCalls[index].function.name =
                  toolCallDelta.function.name;
              }
              if (toolCallDelta.function?.arguments) {
                accumulatedToolCalls[index].function.arguments +=
                  toolCallDelta.function.arguments;
              }
            }
          }
        }

        let assistantMessage: OpenAIProvider.Chat.Completions.ChatCompletionMessage =
          {
            role: "assistant",
            content: accumulatedContent || null,
            refusal: accumulatedRefusal || null,
            tool_calls:
              accumulatedToolCalls.length > 0
                ? accumulatedToolCalls
                : undefined,
          };

        // Evaluate tool invocation policies dynamically
        const toolInvocationRefusal =
          await utils.toolInvocation.evaluatePolicies(
            (assistantMessage.tool_calls || []).map((toolCall) => {
              if (toolCall.type === "function") {
                return {
                  toolCallName: toolCall.function.name,
                  toolCallArgs: toolCall.function.arguments,
                };
              } else {
                return {
                  toolCallName: toolCall.custom.name,
                  toolCallArgs: toolCall.custom.input,
                };
              }
            }),
            resolvedAgentId,
            contextIsTrusted,
          );

        // If there are tool calls, evaluate policies and stream the result
        if (accumulatedToolCalls.length > 0) {
          if (toolInvocationRefusal) {
            const [refusalMessage, contentMessage] = toolInvocationRefusal;
            /**
             * Tool invocation was blocked
             *
             * Overwrite the assistant message that will be persisted
             * and stream the refusal message
             */
            assistantMessage = {
              role: "assistant",
              /**
               * NOTE: the reason why we store the "refusal message" in both the refusal and content fields
               * is that most clients expect to see the content field, and don't conditionally render the refusal field
               *
               * We also set the refusal field, because this will allow the Archestra UI to not only display the refusal
               * message, but also show some special UI to indicate that the tool call was blocked.
               */
              refusal: refusalMessage,
              content: contentMessage,
            };

            // Stream the refusal as a single chunk
            const refusalChunk = {
              id: "chatcmpl-blocked",
              object: "chat.completion.chunk" as const,
              created: Date.now() / 1000,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta:
                    assistantMessage as OpenAIProvider.Chat.Completions.ChatCompletionChunk.Choice.Delta,
                  finish_reason: "stop" as const,
                  logprobs: null,
                },
              ],
            };
            reply.raw.write(`data: ${JSON.stringify(refusalChunk)}\n\n`);
          } else {
            // Tool calls are allowed
            // We must match OpenAI's actual streaming format: send separate chunks for id, name, and arguments
            for (const [index, toolCall] of accumulatedToolCalls.entries()) {
              const baseChunk = {
                id: chunks[0]?.id || "chatcmpl-unknown",
                object: "chat.completion.chunk" as const,
                created: chunks[0]?.created || Date.now() / 1000,
                model: body.model,
              };

              // Chunk 1: Send id and type (no function object to avoid client concatenation bugs)
              const idChunk = {
                ...baseChunk,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index,
                          id: toolCall.id,
                          type: "function" as const,
                        },
                      ],
                    },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              };
              reply.raw.write(`data: ${JSON.stringify(idChunk)}\n\n`);

              // Chunk 2: Send function name (with id so clients can use assignment)
              const nameChunk = {
                ...baseChunk,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index,
                          id: toolCall.id,
                          function: { name: toolCall.function.name },
                        },
                      ],
                    },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              };
              reply.raw.write(`data: ${JSON.stringify(nameChunk)}\n\n`);

              // Chunk 3: Send function arguments (with id so clients can use assignment)
              const argsChunk = {
                ...baseChunk,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index,
                          id: toolCall.id,
                          function: { arguments: toolCall.function.arguments },
                        },
                      ],
                    },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              };
              reply.raw.write(`data: ${JSON.stringify(argsChunk)}\n\n`);
            }

            // Execute MCP tools and continue streaming conversation
            if (accumulatedToolCalls.length > 0) {
              const commonToolCalls =
                utils.adapters.openai.toolCallsToCommon(accumulatedToolCalls);

              fastify.log.info(
                {
                  resolvedAgentId,
                  toolCalls: commonToolCalls.map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    argumentKeys: Object.keys(tc.arguments),
                  })),
                },
                "Executing MCP tool calls (streaming)",
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
                "MCP tool calls completed (streaming)",
              );

              if (mcpResults.length > 0) {
                // Convert MCP results to OpenAI tool messages
                const toolMessages =
                  utils.adapters.openai.toolResultsToMessages(mcpResults);

                // Update conversation with tool results
                const updatedMessages = [
                  ...filteredMessages,
                  assistantMessage,
                  ...toolMessages,
                ];

                /**
                 * Make another streaming call with the tool results (without tools to prevent loops)
                 *
                 * We also need to remove tool_choice otherwise openai complains about:
                 * "400 Invalid value for 'tool_choice': 'tool_choice' is only allowed when 'tools' are specified"
                 */
                const continuationStream =
                  await utils.tracing.startActiveLlmSpan(
                    "openai.chat.completions.continuation",
                    "openai",
                    body.model,
                    true,
                    resolvedAgent,
                    async (continuationSpan) => {
                      continuationSpan.setAttribute("llm.continuation", true);
                      const response =
                        await openAiClient.chat.completions.create({
                          ...body,
                          messages: updatedMessages,
                          tools: undefined,
                          tool_choice: undefined,
                          stream: true,
                        });
                      continuationSpan.end();
                      return response;
                    },
                  );

                // Stream the continuation response
                for await (const chunk of continuationStream) {
                  reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
              }
            }
          }
        }

        // Report token usage metrics for streaming
        if (usageTokens) {
          reportLLMTokens(
            "openai",
            resolvedAgent,
            usageTokens.input,
            usageTokens.output,
          );
        }

        // Store the complete interaction
        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "openai:chatCompletions",
          request: body,
          response: {
            id: chunks[0]?.id || "chatcmpl-unknown",
            object: "chat.completion",
            created: chunks[0]?.created || Date.now() / 1000,
            model: body.model,
            choices: [
              {
                index: 0,
                message: assistantMessage,
                finish_reason: "stop",
                logprobs: null,
              },
            ],
          },
          model: body.model,
          inputTokens: usageTokens?.input || null,
          outputTokens: usageTokens?.output || null,
        });

        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      } else {
        // Non-streaming response with span to measure LLM call duration
        let response = await utils.tracing.startActiveLlmSpan(
          "openai.chat.completions",
          "openai",
          body.model,
          false,
          resolvedAgent,
          async (llmSpan) => {
            const response = await openAiClient.chat.completions.create({
              ...body,
              messages: filteredMessages,
              tools: mergedTools.length > 0 ? mergedTools : undefined,
              stream: false,
            });
            llmSpan.end();
            return response;
          },
        );

        let assistantMessage = response.choices[0].message;

        // Evaluate tool invocation policies dynamically
        const toolInvocationRefusal =
          await utils.toolInvocation.evaluatePolicies(
            (assistantMessage.tool_calls || []).map((toolCall) => {
              if (toolCall.type === "function") {
                return {
                  toolCallName: toolCall.function.name,
                  toolCallArgs: toolCall.function.arguments,
                };
              } else {
                return {
                  toolCallName: toolCall.custom.name,
                  toolCallArgs: toolCall.custom.input,
                };
              }
            }),
            resolvedAgentId,
            contextIsTrusted,
          );

        if (toolInvocationRefusal) {
          const [refusalMessage, contentMessage] = toolInvocationRefusal;
          assistantMessage = {
            role: "assistant",
            refusal: refusalMessage,
            content: contentMessage,
          };
          response.choices = [
            {
              index: 0,
              message: assistantMessage,
              finish_reason: "stop",
              logprobs: null,
            },
          ];
        } else if (
          assistantMessage.tool_calls &&
          assistantMessage.tool_calls.length > 0
        ) {
          // Tool calls are allowed - execute MCP tools
          const commonToolCalls = utils.adapters.openai.toolCallsToCommon(
            assistantMessage.tool_calls,
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
            // Convert MCP results to OpenAI tool messages and append to response
            const toolMessages =
              utils.adapters.openai.toolResultsToMessages(mcpResults);

            // For non-streaming, we need to make another LLM call with the tool results
            const updatedMessages = [
              ...filteredMessages,
              assistantMessage,
              ...toolMessages,
            ];

            /**
             * Make another call with the tool results (without tools to prevent loops)
             *
             * We also need to remove tool_choice otherwise openai complains about:
             * "400 Invalid value for 'tool_choice': 'tool_choice' is only allowed when 'tools' are specified"
             */
            const finalResponse = await utils.tracing.startActiveLlmSpan(
              "openai.chat.completions.continuation",
              "openai",
              body.model,
              false,
              resolvedAgent,
              async (continuationSpan) => {
                continuationSpan.setAttribute("llm.continuation", true);
                const response = await openAiClient.chat.completions.create({
                  ...body,
                  messages: updatedMessages,
                  tools: undefined,
                  tool_choice: undefined,
                  stream: false,
                });
                continuationSpan.end();
                return response;
              },
            );

            // Update the response with the final LLM response
            response = finalResponse;
            assistantMessage = finalResponse.choices[0].message;
          }
        }

        // Extract token usage from response
        const tokenUsage = response.usage
          ? utils.adapters.openai.getUsageTokens(response.usage)
          : { input: null, output: null };

        // Store the complete interaction
        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "openai:chatCompletions",
          request: body,
          response,
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
   * No agentId is provided -- agent is created/fetched based on the user-agent header
   * or if the user-agent header is not present, a default agent is used
   */
  fastify.post(
    `${API_PREFIX}/${CHAT_COMPLETIONS_SUFFIX}`,
    {
      schema: {
        operationId: RouteId.OpenAiChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with OpenAI (uses default agent)",
        tags: ["llm-proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: {
          200: OpenAi.API.ChatCompletionResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body, headers }, reply) => {
      return handleChatCompletion(body, headers, reply);
    },
  );

  /**
   * An agentId is provided -- agent is fetched based on the agentId
   */
  fastify.post(
    `${API_PREFIX}/:agentId/${CHAT_COMPLETIONS_SUFFIX}`,
    {
      schema: {
        operationId: RouteId.OpenAiChatCompletionsWithAgent,
        description:
          "Create a chat completion with OpenAI for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: {
          200: OpenAi.API.ChatCompletionResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body, headers, params }, reply) => {
      return handleChatCompletion(body, headers, reply, params.agentId);
    },
  );
};

export default openAiProxyRoutes;
