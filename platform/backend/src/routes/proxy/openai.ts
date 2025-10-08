import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import OpenAI from "openai";
import { InteractionModel } from "@/models";
import { ErrorResponseSchema, OpenAi } from "@/types";
import { ChatCompletionsHeadersSchema } from "./types";
import * as utils from "./utils";

const openAiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = "/v1";
  const CHAT_COMPLETIONS_ROUTE = `${API_PREFIX}/chat/completions`;

  /**
   * Register HTTP proxy for all OpenAI routes EXCEPT chat/completions
   * This will proxy routes like /v1/models to https://api.openai.com/v1/models
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: "https://api.openai.com/v1",
    prefix: API_PREFIX,
    // Exclude chat/completions route since we handle it specially below
    preHandler: (request, _reply, done) => {
      if (request.method === "POST" && request.url === CHAT_COMPLETIONS_ROUTE) {
        // Skip proxy for this route - we handle it below
        done(new Error("skip"));
      } else {
        done();
      }
    },
  });

  // Handle the special chat/completions route with guardrails
  fastify.post(
    CHAT_COMPLETIONS_ROUTE,
    {
      schema: {
        operationId: "openAiChatCompletions",
        description: "Create a chat completion with OpenAI",
        tags: ["llm-proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: ChatCompletionsHeadersSchema,
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
      const { messages, tools, stream } = body;

      const agentId = await utils.getAgentIdFromRequest(headers);
      const { authorization: openAiApiKey } = headers;
      const openAiClient = new OpenAI({ apiKey: openAiApiKey });

      try {
        await utils.persistTools(tools, agentId);

        // Process messages with trusted data policies dynamically
        const { filteredMessages, contextIsTrusted } =
          await utils.trustedData.evaluateIfContextIsTrusted(messages, agentId);

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
          let chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] =
            chatCompletionChunksAndMessage.chunks;

          // Evaluate tool invocation policies dynamically
          const toolInvocationRefusal =
            await utils.toolInvocation.evaluatePolicies(
              assistantMessage,
              agentId,
              contextIsTrusted,
            );

          if (toolInvocationRefusal) {
            /**
             * Tool invocation was blocked
             *
             * Overwrite the assistant message that will be persisted
             * Plus send a single chunk, representing the refusal message instead of original chunks
             */
            assistantMessage = toolInvocationRefusal.message;
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
            agentId,
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
              assistantMessage,
              agentId,
              contextIsTrusted,
            );
          if (toolInvocationRefusal) {
            assistantMessage = toolInvocationRefusal.message;
            response.choices = [toolInvocationRefusal];
          }

          // Store the complete interaction
          await InteractionModel.create({
            agentId,
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
    },
  );
};

export default openAiProxyRoutes;
