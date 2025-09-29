import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { chatModel } from "../models/chat";
import { LLMProviderFactory } from "../providers/factory";

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
          provider: z.string(),
        }),
        body: ChatCompletionRequestSchema,
        response: {
          200: ChatCompletionResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { provider }, body }, reply) => {
      const { chatId, ...requestBody } = body;

      // Validate provider
      if (!LLMProviderFactory.isSupportedProvider(provider)) {
        return reply.status(400).send({
          error: {
            message: `Unsupported provider: ${provider}`,
            type: "invalid_request_error",
          },
        });
      }

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
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return reply.status(500).send({
            error: {
              message: "OPENAI_API_KEY not configured",
              type: "configuration_error",
            },
          });
        }

        const llmProvider = LLMProviderFactory.createProvider(provider, apiKey);

        // Store the user message
        await chatModel.addInteraction(chatId, {
          role: "user",
          content:
            requestBody.messages[requestBody.messages.length - 1].content,
        });

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

        // Store the assistant response
        await chatModel.addInteraction(chatId, {
          role: "assistant",
          content: response.choices[0].message,
        });

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
          provider: z.string(),
        }),
        response: {
          200: ModelsResponseSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { provider } }, reply) => {
      if (!LLMProviderFactory.isSupportedProvider(provider)) {
        return reply.status(400).send({
          error: {
            message: `Unsupported provider: ${provider}`,
            type: "invalid_request_error",
          },
        });
      }

      try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return reply.status(500).send({
            error: {
              message: "OPENAI_API_KEY not configured",
              type: "configuration_error",
            },
          });
        }

        const llmProvider = LLMProviderFactory.createProvider(provider, apiKey);
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
