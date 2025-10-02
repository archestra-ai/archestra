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
        await utils.evaluateTrustedDataPolicies(messages, chatId, agentId);
        await utils.persistUserMessage(messages, chatId);

        let assistantMessage: OpenAI.Chat.Completions.ChatCompletionMessage | null =
          null;

        if (stream) {
          // Handle streaming response
          reply.header("Content-Type", "text/event-stream");
          reply.header("Cache-Control", "no-cache");
          reply.header("Connection", "keep-alive");

          const stream = await openAiClient.chat.completions.create({
            ...body,
            stream: true,
          });

          /**
           * Accumulate the assistant message, and tool calls from chunks
           *
           * NOTE: for right now we ignore "custom" tool calls
           */
          let accumulatedContent = "";
          const accumulatedToolCalls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] =
            [];

          for await (const chunk of stream) {
            console.log("chunk", JSON.stringify(chunk, null, 2));

            const delta = chunk.choices[0]?.delta;

            // Accumulate content
            if (delta?.content) {
              accumulatedContent += delta.content;
            }

            // Accumulate tool calls
            if (delta?.tool_calls) {
              for (const toolCallDelta of delta.tool_calls.filter(
                (toolCall) => toolCall.type === "function",
              )) {
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

            // Stream chunk to client
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          // Construct the complete assistant message
          assistantMessage = {
            role: "assistant",
            content: accumulatedContent || null,
            tool_calls:
              accumulatedToolCalls.length > 0
                ? accumulatedToolCalls
                : undefined,
          } as OpenAI.Chat.Completions.ChatCompletionMessage;

          const toolInvocationPolicyError =
            await utils.evaluateToolInvocationPolicies(
              assistantMessage,
              agentId,
            );

          if (toolInvocationPolicyError) {
            // When streaming, we can't send a 403 status after headers are sent
            // Instead, send an error event in SSE format
            reply.raw.write(
              `data: ${JSON.stringify({ error: toolInvocationPolicyError })}\n\n`,
            );
            reply.raw.write("data: [DONE]\n\n");
            reply.raw.end();
            return reply;
          }

          await utils.persistAssistantMessage(assistantMessage, chatId);

          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          return reply;
        } else {
          const response = await openAiClient.chat.completions.create({
            ...body,
            stream: false,
          });

          assistantMessage = response.choices[0].message;

          const toolInvocationPolicyError =
            await utils.evaluateToolInvocationPolicies(
              assistantMessage,
              agentId,
            );
          if (toolInvocationPolicyError) {
            return reply.status(403).send(toolInvocationPolicyError);
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
