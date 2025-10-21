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
      await utils.persistTools(
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

      // Convert to common format and evaluate trusted data policies
      const commonMessages = utils.adapters.openai.toCommonFormat(messages);
      const { toolResultUpdates, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          commonMessages,
          resolvedAgentId,
          openAiApiKey,
          "openai",
        );

      // Apply updates back to OpenAI messages
      const filteredMessages = utils.adapters.openai.applyUpdates(
        messages,
        toolResultUpdates,
      );

      if (stream) {
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-cache");
        reply.header("Connection", "keep-alive");

        // Handle streaming response
        const stream = await openAiClient.chat.completions.create({
          ...body,
          messages: filteredMessages,
          stream: true,
        });

        const chatCompletionChunksAndMessage =
          await utils.streaming.handleChatCompletions(stream);

        let assistantMessage = chatCompletionChunksAndMessage.message;
        let chunks: OpenAIProvider.Chat.Completions.ChatCompletionChunk[] =
          chatCompletionChunksAndMessage.chunks;

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
          /**
           * Tool invocation was blocked
           *
           * Overwrite the assistant message that will be persisted
           * Plus send a single chunk, representing the refusal message instead of original chunks
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
          chunks = [
            {
              id: "chatcmpl-blocked",
              object: "chat.completion.chunk",
              created: Date.now() / 1000, // the type annotation for created mentions that it is in seconds
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta:
                    assistantMessage as OpenAIProvider.Chat.Completions.ChatCompletionChunk.Choice.Delta,
                  finish_reason: "stop",
                  logprobs: null,
                },
              ],
            },
          ];
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

        for (const chunk of chunks) {
          /**
           * The setTimeout here is used simply to simulate the streaming delay (and make it look more natural)
           */
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 10),
          );
        }

        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      } else {
        const response = await openAiClient.chat.completions.create({
          ...body,
          messages: filteredMessages,
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
