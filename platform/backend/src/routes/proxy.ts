import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "../config";
import ToolInvocationPolicyEvaluator from "../guardrails/tool-invocation";
import TrustedDataPolicyEvaluator from "../guardrails/trusted-data";
import ChatModel from "../models/chat";
import InteractionModel from "../models/interaction";
import { createProvider, SupportedProvidersSchema } from "../providers/factory";
import { ErrorResponseSchema } from "./schemas";

const {
  trustedDataAutonomyPolicies,
  toolInvocationAutonomyPolicies,
  openAi: { apiKey: openAiApiKey },
} = config;

type InteractionContent = {
  role: string;
  tool_calls: {
    id: string;
    function: {
      name: string;
    };
  }[];
};

// Register Zod schemas for OpenAPI
const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.any()), // OpenAI message format
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  stream: z.boolean().optional(),
});

const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  choices: z.array(z.any()),
  usage: z.any().optional(),
});

const ModelsResponseSchema = z.object({
  data: z.array(z.any()),
});

/**
 * Extract tool name from conversation history by finding the assistant message
 * that contains the tool_call_id
 */
async function extractToolNameFromHistory(
  chatId: string,
  toolCallId: string,
): Promise<string | null> {
  const interactions = await InteractionModel.findByChatId(chatId);

  // Find the most recent assistant message with tool_calls
  for (let i = interactions.length - 1; i >= 0; i--) {
    const interaction = interactions[i];
    const content = interaction.content as InteractionContent;

    if (content.role === "assistant" && content.tool_calls) {
      for (const toolCall of content.tool_calls) {
        if (toolCall.id === toolCallId) {
          return toolCall.function.name;
        }
      }
    }
  }

  return null;
}

const llmProviderProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/v1/:provider/chat/completions",
    {
      schema: {
        operationId: "chatCompletions",
        description: "Create a chat completion with the specified LLM provider",
        tags: ["LLM"],
        params: z.object({
          provider: SupportedProvidersSchema,
        }),
        body: ChatCompletionRequestSchema,
        headers: z.object({
          "x-archestra-chat-id": z.string().uuid(),
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
        params: { provider },
        body: { ...requestBody },
        headers: { "x-archestra-chat-id": chatId },
      },
      reply,
    ) => {
      // Validate chat exists
      const chat = await ChatModel.findById(chatId);
      if (!chat) {
        return reply.status(404).send({
          error: {
            message: "Chat not found",
            type: "invalid_request_error",
          },
        });
      }

      try {
        const llmProvider = createProvider(provider, openAiApiKey);

        // Process incoming tool result messages and evaluate trusted data policies
        for (const message of requestBody.messages) {
          // biome-ignore lint/suspicious/noExplicitAny: tbd later
          if ((message as any).role === "tool") {
            // biome-ignore lint/suspicious/noExplicitAny: tbd later
            const toolMessage = message as any;
            const toolResult = JSON.parse(toolMessage.content);

            // Extract tool name from conversation history
            const toolName = await extractToolNameFromHistory(
              chatId,
              toolMessage.tool_call_id,
            );

            if (toolName) {
              // Evaluate trusted data policy
              const evaluator = new TrustedDataPolicyEvaluator(
                {
                  toolName,
                  toolCallId: toolMessage.tool_call_id,
                  output: toolResult,
                },
                trustedDataAutonomyPolicies,
              );

              const { isTrusted, trustReason } = evaluator.evaluate();

              // Store tool result as interaction (tainted if not trusted)
              await InteractionModel.create({
                chatId,
                content: toolMessage,
                tainted: !isTrusted,
                taintReason: trustReason,
              });
            }
          }
        }

        // Store the user message
        const lastMessage =
          requestBody.messages[requestBody.messages.length - 1];
        // biome-ignore lint/suspicious/noExplicitAny: tbd later
        if ((lastMessage as any).role === "user") {
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

          for await (const chunk of llmProvider.chatCompletionStream(
            requestBody,
          )) {
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          return;
        }

        // Handle non-streaming response
        const response = await llmProvider.chatCompletion(requestBody);

        const assistantMessage = response.choices[0].message;

        // Intercept and evaluate tool calls
        if (
          assistantMessage.tool_calls &&
          assistantMessage.tool_calls.length > 0
        ) {
          for (const toolCall of assistantMessage.tool_calls) {
            // Only process function tool calls (not custom tool calls)
            if (toolCall.type === "function" && "function" in toolCall) {
              const toolInput = JSON.parse(toolCall.function.arguments);

              fastify.log.info(
                `Evaluating tool call: ${
                  toolCall.function.name
                } with input: ${JSON.stringify(toolInput)}`,
              );

              const evaluator = new ToolInvocationPolicyEvaluator(
                {
                  toolName: toolCall.function.name,
                  toolCallId: toolCall.id,
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

  fastify.get(
    "/v1/:provider/models",
    {
      schema: {
        operationId: "listProviderModels",
        description: "List available models for the specified provider",
        tags: ["LLM"],
        params: z.object({
          provider: SupportedProvidersSchema,
        }),
        response: {
          200: ModelsResponseSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { provider } }, reply) => {
      try {
        const llmProvider = createProvider(provider, openAiApiKey);
        const models = await llmProvider.listModels();

        return reply.send({ data: models });
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

export default llmProviderProxyRoutes;
