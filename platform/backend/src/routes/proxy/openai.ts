import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import OpenAI from "openai";
import { ErrorResponseSchema, OpenAi } from "../../types";
import { ChatCompletionsHeadersSchema } from "./types";
import * as utils from "./utils";

const openAiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = "/api/proxy/openai";
  const CHAT_COMPLETIONS_ROUTE = `${API_PREFIX}/chat/completions`;

  /**
   * Register HTTP proxy for all OpenAI routes EXCEPT chat/completions
   * This will proxy routes like /api/proxy/openai/models to https://api.openai.com/v1/models
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

      const chatAndAgent = await utils.getAgentAndChatIdFromRequest(
        messages,
        headers,
      );

      if ("error" in chatAndAgent) {
        return reply.status(400).send(chatAndAgent);
      }

      const { chatId, agentId } = chatAndAgent;
      const { authorization: openAiApiKey } = headers;
      const openAiClient = new OpenAI({ apiKey: openAiApiKey });

      try {
        await utils.persistTools(tools, agentId);
        await utils.trustedData.evaluatePolicies(messages, chatId);
        await utils.persistUserMessage(messages[messages.length - 1], chatId);

        // Redact blocked tool result data before sending to OpenAI
        const filteredMessages =
          await utils.trustedData.redactBlockedToolResultData(chatId, messages);

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

          const toolInvocationRefusal =
            await utils.toolInvocation.evaluatePolicies(
              assistantMessage,
              chatId,
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
                    delta: {
                      role: "assistant",
                      content: null,
                      refusal: toolInvocationRefusal.message.refusal,
                    },
                    finish_reason: "stop",
                    logprobs: null,
                  },
                ],
              },
            ];
          }

          await utils.persistAssistantMessage(assistantMessage, chatId);

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

          const toolInvocationRefusal =
            await utils.toolInvocation.evaluatePolicies(
              assistantMessage,
              chatId,
            );
          if (toolInvocationRefusal) {
            assistantMessage = toolInvocationRefusal.message;
            response.choices = [toolInvocationRefusal];
          }

          await utils.persistAssistantMessage(assistantMessage, chatId);

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
