import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import OpenAI from "openai";
import { z } from "zod";
import {
  ChatModel,
  InteractionModel,
  ToolInvocationPolicyModel,
  ToolModel,
  TrustedDataPolicyModel,
} from "../../models";
import { ErrorResponseSchema, OpenAi, UuidIdSchema } from "../../types";

/**
 * Extract tool name from conversation history by finding the assistant message
 * that contains the tool_call_id
 *
 * We need to do this because the name of the tool is not included in the "tool" message (ie. tool call result)
 * (just the content and tool_call_id)
 */
const extractToolNameFromHistory = async (
  chatId: string,
  toolCallId: string,
): Promise<string | null> => {
  const interactions = await InteractionModel.findByChatId(chatId);

  // Find the most recent assistant message with tool_calls
  for (let i = interactions.length - 1; i >= 0; i--) {
    const { content } = interactions[i];

    if (content.role === "assistant" && content.tool_calls) {
      for (const toolCall of content.tool_calls) {
        /**
         * TODO: do we need to handle custom tool calls here as well?
         */
        if (toolCall.id === toolCallId && toolCall.type === "function") {
          return toolCall.function.name;
        }
      }
    }
  }

  return null;
};

/**
 * NOTE: we may just want to use something like fastify-http-proxy to proxy ALL openai endpoints
 * except for the ones that we are handling "specially" (ex. chat/completions)
 *
 * https://github.com/fastify/fastify-http-proxy
 *
 * Also see https://github.com/archestra-ai/archestra/blob/ba98a62945ff23a0d2075dfd415cdd358bd61991/desktop_app/src/backend/server/plugins/ollama/proxy.ts
 * for how we are handling this in the desktop app ollama proxy
 */
const openAiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/proxy/openai/chat/completions",
    {
      schema: {
        operationId: "openAiChatCompletions",
        description: "Create a chat completion with OpenAI",
        tags: ["llm-proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: z.object({
          "x-archestra-chat-id": UuidIdSchema,
          authorization: OpenAi.API.ApiKeySchema,
        }),
        response: {
          200: OpenAi.API.ChatCompletionResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (
      {
        body: { ...requestBody },
        headers: { "x-archestra-chat-id": chatId, authorization: openAiApiKey },
      },
      reply,
    ) => {
      // Validate chat exists and get agent ID
      const chat = await ChatModel.findById(chatId);
      if (!chat) {
        return reply.status(404).send({
          error: {
            message: "Chat not found",
            type: "invalid_request_error",
          },
        });
      }
      const agentId = chat.agentId;

      const openAiClient = new OpenAI({ apiKey: openAiApiKey });

      try {
        /**
         * Persist tools if present in the request
         *
         * NOTE: for right now we are only persisting function tools (not custom tools)
         */
        const tools =
          requestBody.tools?.filter((tool) => tool.type === "function") || [];

        for (const {
          function: { name, parameters, description },
        } of tools) {
          await ToolModel.createToolIfNotExists({
            agentId,
            name,
            parameters,
            description,
          });
        }

        // Process incoming tool result messages and evaluate trusted data policies
        for (const message of requestBody.messages) {
          if (message.role === "tool") {
            const { tool_call_id: toolCallId, content } = message;
            const toolResult =
              typeof content === "string" ? JSON.parse(content) : content;

            // Extract tool name from conversation history
            const toolName = await extractToolNameFromHistory(
              chatId,
              toolCallId,
            );

            if (toolName) {
              // Evaluate trusted data policy
              const { isTrusted, trustReason } =
                await TrustedDataPolicyModel.evaluateForAgent(
                  agentId,
                  toolName,
                  toolResult,
                );

              // Store tool result as interaction (tainted if not trusted)
              await InteractionModel.create({
                chatId,
                content: message,
                tainted: !isTrusted,
                taintReason: trustReason,
              });
            }
          }
        }

        // Store the user message
        const lastMessage =
          requestBody.messages[requestBody.messages.length - 1];

        if (lastMessage.role === "user") {
          await InteractionModel.create({
            chatId,
            content: lastMessage,
          });
        }

        // Handle streaming response
        if (requestBody.stream) {
          reply.header("Content-Type", "text/event-stream");
          reply.header("Cache-Control", "no-cache");
          reply.header("Connection", "keep-alive");

          const stream = await openAiClient.chat.completions.create({
            ...requestBody,
            stream: true,
          });

          for await (const chunk of stream) {
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          return;
        }

        // Handle non-streaming response
        const response = await openAiClient.chat.completions.create({
          ...requestBody,
          stream: false,
        });

        const assistantMessage = response.choices[0].message;

        // Intercept and evaluate tool calls
        if (
          assistantMessage.tool_calls &&
          assistantMessage.tool_calls.length > 0
        ) {
          for (const toolCall of assistantMessage.tool_calls) {
            // Only process function tool calls (not custom tool calls)
            if (toolCall.type === "function") {
              const {
                function: { arguments: toolCallArgs, name: toolCallName },
              } = toolCall;
              const toolInput = JSON.parse(toolCallArgs);

              fastify.log.info(
                `Evaluating tool call: ${toolCallName} with input: ${JSON.stringify(toolInput)}`,
              );

              // Evaluate tool invocation policy
              const { isAllowed, denyReason } =
                await ToolInvocationPolicyModel.evaluateForAgent(
                  agentId,
                  toolCallName,
                  toolInput,
                );

              fastify.log.info(
                `Tool evaluation result: ${isAllowed} with deny reason: ${denyReason}`,
              );

              if (!isAllowed) {
                // Block this tool call
                return reply.status(403).send({
                  error: {
                    message: denyReason,
                    type: "tool_invocation_blocked",
                  },
                });
              }
            }
          }
        }

        await InteractionModel.create({
          chatId,
          content: assistantMessage,
        });

        return reply.send(response);
      } catch (error) {
        fastify.log.error(error);
        const statusCode =
          error instanceof Error && "status" in error
            ? (error.status as 200 | 400 | 404 | 403 | 500)
            : 500;
        const errorMessage =
          error instanceof Error ? error.message : "Internal server error";

        return reply.status(statusCode).send({
          error: {
            message: errorMessage,
            type: "api_error",
          },
        });
      }
    },
  );
};

export default openAiProxyRoutes;
