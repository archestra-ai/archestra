import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { chatModel } from "../models/chat";
import { createProvider, SupportedProvidersSchema } from "../providers/factory";
import config from "../config";
import ToolInvocationPolicyEvaluator from "../guardrails/tool-invocation";
import TrustedDataPolicyEvaluator from "../guardrails/trusted-data";

const { trustedDataAutonomyPolicies, toolInvocationAutonomyPolicies, openAi: { apiKey: openAiApiKey } } = config;

// Register Zod schemas for OpenAPI
const ChatIdResponseSchema = z.object({
  chatId: z.string().uuid(),
});

const ErrorResponseSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      message: z.string(),
      type: z.string(),
    }),
  ]),
});

const ChatCompletionRequestSchema = z.object({
  chatId: z.string().uuid(),
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

// Register schemas in global registry for OpenAPI refs
z.globalRegistry.add(ChatIdResponseSchema, { id: "ChatIdResponse" });
z.globalRegistry.add(ErrorResponseSchema, { id: "ErrorResponse" });
z.globalRegistry.add(ChatCompletionRequestSchema, {
  id: "ChatCompletionRequest",
});
z.globalRegistry.add(ChatCompletionResponseSchema, {
  id: "ChatCompletionResponse",
});
z.globalRegistry.add(ModelsResponseSchema, { id: "ModelsResponse" });

/**
 * Extract tool name from conversation history by finding the assistant message
 * that contains the tool_call_id
 */
async function extractToolNameFromHistory(
  chatId: string,
  toolCallId: string
): Promise<string | null> {
  const interactions = await chatModel.getInteractions(chatId);

  // Find the most recent assistant message with tool_calls
  for (let i = interactions.length - 1; i >= 0; i--) {
    const interaction = interactions[i];
    const content = interaction.content as any;

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

export const chatRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Create a new chat session
  fastify.post(
    "/api/chats",
    {
      schema: {
        operationId: "createChat",
        description: "Create a new chat session",
        tags: ["Chat"],
        response: {
          200: ChatIdResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const chat = await chatModel.create();
      return reply.send({ chatId: chat.id });
    },
  );

  // Get chat by ID
  fastify.get(
    "/api/chats/:chatId",
    {
      schema: {
        operationId: "getChat",
        description: "Get chat by ID",
        tags: ["Chat"],
        params: z.object({
          chatId: z.string().uuid(),
        }),
        response: {
          200: z.any(), // Full chat with interactions
          404: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { chatId } }, reply) => {
      const chat = await chatModel.findById(chatId);

      if (!chat) {
        return reply.status(404).send({ error: "Chat not found" });
      }

      return reply.send(chat);
    },
  );

  // Chat completions endpoint with provider support
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
        response: {
          200: ChatCompletionResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { provider }, body: { chatId, ...requestBody } }, reply) => {

      // Validate chat exists
      const chat = await chatModel.findById(chatId);
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
          if ((message as any).role === "tool") {
            const toolMessage = message as any;
            const toolResult = JSON.parse(toolMessage.content);

            // Extract tool name from conversation history
            const toolName = await extractToolNameFromHistory(chatId, toolMessage.tool_call_id);

            if (toolName) {
              // Evaluate trusted data policy
              const evaluator = new TrustedDataPolicyEvaluator(
                {
                  toolName,
                  toolCallId: toolMessage.tool_call_id,
                  output: toolResult,
                },
                trustedDataAutonomyPolicies
              );

              const { isTrusted, trustReason } = evaluator.evaluate();

              // Store tool result as interaction (tainted if not trusted)
              await chatModel.addInteraction(chatId, toolMessage, !isTrusted, trustReason);
            }
          }
        }

        // Store the user message
        const lastMessage = requestBody.messages[requestBody.messages.length - 1];
        if ((lastMessage as any).role === "user") {
          await chatModel.addInteraction(chatId, lastMessage);
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
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          for (const toolCall of assistantMessage.tool_calls) {
            // Only process function tool calls (not custom tool calls)
            if (toolCall.type === 'function' && 'function' in toolCall) {
              const toolInput = JSON.parse(toolCall.function.arguments);

              fastify.log.info(`Evaluating tool call: ${toolCall.function.name} with input: ${JSON.stringify(toolInput)}`);

              const evaluator = new ToolInvocationPolicyEvaluator(
                {
                  toolName: toolCall.function.name,
                  toolCallId: toolCall.id,
                  input: toolInput,
                },
                toolInvocationAutonomyPolicies
              );

              const { isAllowed, denyReason } = evaluator.evaluate();

              fastify.log.info(`Tool evaluation result: ${isAllowed} with deny reason: ${denyReason}`);

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
        await chatModel.addInteraction(chatId, assistantMessage);

        return reply.send(response);
      } catch (error) {
        fastify.log.error(error);
        const statusCode =
          error instanceof Error && "status" in error
            ? (error as any).status
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

  // List models endpoint
  fastify.get(
    "/v1/:provider/models",
    {
      schema: {
        operationId: "listModels",
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
