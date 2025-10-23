import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import OpenAIProvider from "openai";
import { z } from "zod";
import config from "@/config";
import { AgentModel, InteractionModel } from "@/models";
import { ErrorResponseSchema, OpenAi, RouteId, UuidIdSchema } from "@/types";
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
   * Register HTTP proxy for all OpenAI routes EXCEPT chat/completions
   * This will proxy routes like /v1/openai/models to https://api.openai.com/v1/models
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: "https://api.openai.com",
    prefix: API_PREFIX,
    rewritePrefix: "/v1",
    // Exclude chat/completions route since we handle it specially below
    preHandler: (request, _reply, next) => {
      if (
        request.method === "POST" &&
        request.url.includes(CHAT_COMPLETIONS_SUFFIX)
      ) {
        // Skip proxy for this route - we handle it below
        next(new Error("skip"));
      } else {
        next();
      }
    },
  });

  /**
   * Register HTTP proxy for agent-specific routes /v1/openai/:agentId/* EXCEPT chat/completions
   * This allows using /v1/openai/:agentId/ as a base URL for OpenAI API calls
   * Example: /v1/openai/:agentId/models -> https://api.openai.com/v1/models
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: "https://api.openai.com",
    prefix: `${API_PREFIX}/:agentId`,
    rewritePrefix: "/v1",
    // Exclude chat/completions route since we handle it specially below
    preHandler: (request, _reply, next) => {
      if (
        request.method === "POST" &&
        request.url.includes(CHAT_COMPLETIONS_SUFFIX)
      ) {
        // Skip proxy for this route - we handle it below
        next(new Error("skip"));
      } else {
        next();
      }
    },
  });

  const handleChatCompletion = async (
    body: OpenAi.Types.ChatCompletionsRequest,
    headers: OpenAi.Types.ChatCompletionsHeaders,
    reply: FastifyReply,
    agentId?: string,
  ) => {
    const { messages, tools, stream } = body;

    let resolvedAgentId: string;
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
      resolvedAgentId = agentId;
    } else {
      // Otherwise get or create default agent
      resolvedAgentId = await utils.getAgentIdFromRequest(
        headers["user-agent"],
      );
    }

    const { authorization: openAiApiKey } = headers;
    const openAiClient = config.benchmark.mockMode
      ? (new MockOpenAIClient() as unknown as OpenAIProvider)
      : new OpenAIProvider({ apiKey: openAiApiKey });

    try {
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

      // Convert to common format and evaluate trusted data policies
      const commonMessages = utils.adapters.openai.toCommonFormat(messages);

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

      if (stream) {
        // Handle streaming response
        const stream = await openAiClient.chat.completions.create({
          ...body,
          messages: filteredMessages,
          tools: mergedTools.length > 0 ? mergedTools : undefined,
          stream: true,
        });

        // Accumulate tool calls and track content for persistence
        let accumulatedContent = "";
        let accumulatedRefusal = "";
        const accumulatedToolCalls: OpenAIProvider.Chat.Completions.ChatCompletionMessageFunctionToolCall[] =
          [];
        const chunks: OpenAIProvider.Chat.Completions.ChatCompletionChunk[] =
          [];

        for await (const chunk of stream) {
          chunks.push(chunk);
          const delta = chunk.choices[0]?.delta;

          // Stream text content immediately
          if (delta?.content || delta?.refusal) {
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
            // Tool calls are allowed - stream them now
            for (const chunk of chunks) {
              if (chunk.choices[0]?.delta?.tool_calls) {
                reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            }

            // Execute MCP tools and continue streaming conversation
            if (accumulatedToolCalls.length > 0) {
              const commonToolCalls =
                utils.adapters.openai.toolCallsToCommon(accumulatedToolCalls);
              const mcpResults = await utils.tools.executeMcpToolCalls(
                commonToolCalls,
                resolvedAgentId,
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
                  await openAiClient.chat.completions.create({
                    ...body,
                    messages: updatedMessages,
                    tools: undefined,
                    tool_choice: undefined,
                    stream: true,
                  });

                // Stream the continuation response
                for await (const chunk of continuationStream) {
                  reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
              }
            }
          }
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
        });

        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      } else {
        let response = await openAiClient.chat.completions.create({
          ...body,
          messages: filteredMessages,
          tools: mergedTools.length > 0 ? mergedTools : undefined,
          stream: false,
        });

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

          const mcpResults = await utils.tools.executeMcpToolCalls(
            commonToolCalls,
            resolvedAgentId,
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
            const finalResponse = await openAiClient.chat.completions.create({
              ...body,
              messages: updatedMessages,
              tools: undefined,
              tool_choice: undefined,
              stream: false,
            });

            // Update the response with the final LLM response
            response = finalResponse;
            assistantMessage = finalResponse.choices[0].message;
          }
        }

        // Store the complete interaction
        await InteractionModel.create({
          agentId: resolvedAgentId,
          type: "openai:chatCompletions",
          request: body,
          response,
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
