import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import OpenAI from "openai";
import { z } from "zod";
import { AgentModel, InteractionModel } from "@/models";
import { ErrorResponseSchema, OpenAi, UuidIdSchema } from "@/types";
import { OpenAiProxy } from "./types";
import * as utils from "./utils";

const openAiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = "/v1";
  const CHAT_COMPLETIONS_SUFFIX = "chat/completions";

  /**
   * Register HTTP proxy for all OpenAI routes EXCEPT chat/completions
   * This will proxy routes like /v1/openai/models to https://api.openai.com/v1/models
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: "https://api.openai.com",
    prefix: `${API_PREFIX}/:provider`,
    rewritePrefix: "/v1",
    // Exclude chat/completions route since we handle it specially below
    preHandler: (request, _reply, done) => {
      if (
        request.method === "POST" &&
        request.url.includes("/chat/completions")
      ) {
        // Skip proxy for this route - we handle it below
        done(new Error("skip"));
      } else {
        done();
      }
    },
  });

  const handleChatCompletion = async (
    body: z.infer<typeof OpenAi.API.ChatCompletionRequestSchema>,
    headers: z.infer<typeof OpenAiProxy.ChatCompletionsHeadersSchema>,
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
    const openAiClient = new OpenAI({ apiKey: openAiApiKey });

    try {
      // Filter out custom tools since CommonTool only supports function tools
      const functionTools = tools?.filter(
        (tool): tool is { type: "function"; function: any } =>
          tool.type === "function",
      );
      await utils.persistTools(functionTools, resolvedAgentId);

      // Process messages with trusted data policies dynamically
      const { filteredMessages, contextIsTrusted } =
        await utils.trustedData.evaluateIfContextIsTrusted(
          messages,
          resolvedAgentId,
          openAiApiKey,
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

        // Collect chunks from OpenAI stream
        const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
        let accumulatedContent = "";
        let accumulatedRefusal = "";
        const accumulatedToolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

        for await (const chunk of stream) {
          chunks.push(chunk);
          const delta = chunk.choices[0]?.delta;

          // Accumulate content
          if (delta?.content) {
            accumulatedContent += delta.content;
          }

          if (delta?.refusal) {
            accumulatedRefusal += delta.refusal;
          }

          // Accumulate tool calls
          if (delta?.tool_calls) {
            for (const toolCallDelta of delta.tool_calls) {
              const index = toolCallDelta.index ?? 0;

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

        const assistantMessage: OpenAI.Chat.Completions.ChatCompletionMessage = {
          role: "assistant",
          content: accumulatedContent || null,
          refusal: accumulatedRefusal || null,
          tool_calls:
            accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
        };

        let finalAssistantMessage = assistantMessage;
        let finalChunks = chunks;

        // Evaluate tool invocation policies dynamically
        const toolInvocationRefusal =
          await utils.toolInvocation.evaluatePolicies(
            finalAssistantMessage,
            resolvedAgentId,
            contextIsTrusted,
          );

        if (toolInvocationRefusal) {
          /**
           * Tool invocation was blocked
           *
           * Overwrite the assistant message that will be persisted
           * Plus send a single chunk, representing the refusal message instead of original chunks
           */
          finalAssistantMessage = toolInvocationRefusal.message;
          finalChunks = [
            {
              id: "chatcmpl-blocked",
              object: "chat.completion.chunk",
              created: Date.now() / 1000, // the type annotation for created mentions that it is in seconds
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta:
                    toolInvocationRefusal.message as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
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
          provider: "openai" as const,
          request: body,
          response: {
            id: chunks[0]?.id || "chatcmpl-unknown",
            object: "chat.completion",
            created: chunks[0]?.created || Date.now() / 1000,
            model: body.model,
            choices: [
              {
                index: 0,
                message: finalAssistantMessage,
                finish_reason: "stop",
                logprobs: null,
              },
            ],
          },
        });

        for (const chunk of finalChunks) {
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
            assistantMessage,
            resolvedAgentId,
            contextIsTrusted,
          );
        if (toolInvocationRefusal) {
          assistantMessage = toolInvocationRefusal.message;
          response.choices = [toolInvocationRefusal];
        }

        // Store the complete interaction
        await InteractionModel.create({
          agentId: resolvedAgentId,
          provider: "openai" as const,
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
    `${API_PREFIX}/openai/${CHAT_COMPLETIONS_SUFFIX}`,
    {
      schema: {
        operationId: "openAiChatCompletionsWithDefaultAgent",
        description:
          "Create a chat completion with OpenAI (uses default agent)",
        tags: ["llm-proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAiProxy.ChatCompletionsHeadersSchema,
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
    `${API_PREFIX}/openai/:agentId/${CHAT_COMPLETIONS_SUFFIX}`,
    {
      schema: {
        operationId: "openAiChatCompletionsWithAgent",
        description:
          "Create a chat completion with OpenAI for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAiProxy.ChatCompletionsHeadersSchema,
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
