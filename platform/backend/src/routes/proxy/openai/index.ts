import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import OpenAI from "openai";
import { z } from "zod";
import config from "../../../config";
import ToolInvocationPolicyEvaluator from "../../../guardrails/tool-invocation";
import TrustedDataPolicyEvaluator from "../../../guardrails/trusted-data";
import ChatModel from "../../../models/chat";
import InteractionModel from "../../../models/interaction";
import { ChatIdSchema, ErrorResponseSchema } from "../../schemas";
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ModelsResponseSchema,
  OpenAiApiKeySchema,
} from "./schemas";

const { trustedDataAutonomyPolicies, toolInvocationAutonomyPolicies } = config;

/**
 * Extract tool name from conversation history by finding the assistant message
 * that contains the tool_call_id
 *
 * TODO: we probably don't need this.. to verify
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
        if (toolCall.id === toolCallId) {
          return toolCall.function.name;
        }
      }
    }
  }

  return null;
};

const openAiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/proxy/openai/chat/completions",
    {
      schema: {
        operationId: "openAiChatCompletions",
        description: "Create a chat completion with OpenAI",
        tags: ["llm-proxy"],
        body: ChatCompletionRequestSchema,
        headers: z.object({
          "x-archestra-chat-id": ChatIdSchema,
          authorization: OpenAiApiKeySchema,
        }),
        response: {
          200: ChatCompletionResponseSchema,
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
      // Validate chat exists
      if (!(await ChatModel.findById(chatId))) {
        return reply.status(404).send({
          error: {
            message: "Chat not found",
            type: "invalid_request_error",
          },
        });
      }

      const openAiClient = new OpenAI({ apiKey: openAiApiKey });

      try {
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
              const evaluator = new TrustedDataPolicyEvaluator(
                {
                  toolName,
                  toolCallId,
                  output: toolResult,
                },
                trustedDataAutonomyPolicies,
              );

              const { isTrusted, trustReason } = evaluator.evaluate();

              // Store tool result as interaction (tainted if not trusted)
              await InteractionModel.create({
                chatId,
                // biome-ignore lint/suspicious/noExplicitAny: tbd later
                content: message as any,
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
            // biome-ignore lint/suspicious/noExplicitAny: tbd later
            content: lastMessage as any,
          });
        }

        // Handle streaming response
        if (requestBody.stream) {
          reply.header("Content-Type", "text/event-stream");
          reply.header("Cache-Control", "no-cache");
          reply.header("Connection", "keep-alive");

          const stream = await openAiClient.chat.completions.create({
            // biome-ignore lint/suspicious/noExplicitAny: tbd later
            ...(requestBody as any),
            stream: true,
          });

          // biome-ignore lint/suspicious/noExplicitAny: tbd later
          for await (const chunk of stream as any) {
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          return;
        }

        // Handle non-streaming response
        const response = await openAiClient.chat.completions.create({
          // biome-ignore lint/suspicious/noExplicitAny: tbd later
          ...(requestBody as any),
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
                id: toolCallId,
                function: { arguments: toolCallArgs, name: toolCallName },
              } = toolCall;
              const toolInput = JSON.parse(toolCallArgs);

              fastify.log.info(
                `Evaluating tool call: ${
                  toolCallName
                } with input: ${JSON.stringify(toolInput)}`,
              );

              const evaluator = new ToolInvocationPolicyEvaluator(
                {
                  toolName: toolCallName,
                  toolCallId,
                  input: toolInput,
                },
                toolInvocationAutonomyPolicies,
              );

              const { isAllowed, denyReason } = evaluator.evaluate();

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

        // Store the assistant response
        await InteractionModel.create({
          chatId,
          // biome-ignore lint/suspicious/noExplicitAny: tbd later
          content: assistantMessage as any,
        });

        // biome-ignore lint/suspicious/noExplicitAny: tbd later
        return reply.send(response as any);
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

  fastify.get(
    "/api/proxy/openai/models",
    {
      schema: {
        operationId: "listOpenAiModels",
        description: "List available models for OpenAI",
        tags: ["llm-proxy"],
        headers: z.object({
          authorization: OpenAiApiKeySchema,
        }),
        response: {
          200: z.array(ModelsResponseSchema),
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ headers: { authorization: openAiApiKey } }, reply) => {
      try {
        const openAiClient = new OpenAI({ apiKey: openAiApiKey });
        const models = await openAiClient.models.list();
        return reply.send(models.data);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
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
