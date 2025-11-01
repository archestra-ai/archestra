import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, streamText } from "ai";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getChatMcpTools } from "@/clients/chat-mcp-client";
import config from "@/config";
import { ConversationModel, MessageModel } from "@/models";
import {
  ErrorResponseSchema,
  InsertConversationSchema,
  RouteId,
  SelectConversationSchema,
  SelectConversationWithMessagesSchema,
  UpdateConversationSchema,
  UuidIdSchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";

const chatRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // ========== Streaming (useChat format) ==========
  fastify.post(
    "/api/chat",
    {
      schema: {
        operationId: RouteId.StreamChat,
        description: "Stream chat response with MCP tools (useChat format)",
        tags: ["Chat"],
        body: z.object({
          id: UuidIdSchema.optional(), // Chat ID from useChat
          messages: z.array(z.any()), // UIMessage[]
          trigger: z.enum(["submit-message", "regenerate-message"]).optional(),
        }),
        response: {
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id: conversationId, messages } = request.body;
      const user = await getUserFromRequest(request);

      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      // Conversation ID is required
      if (!conversationId) {
        return reply.status(400).send({
          error: {
            message: "Conversation ID is required",
            type: "bad_request",
          },
        });
      }

      // Get conversation
      const conversation = await ConversationModel.findById(
        conversationId,
        user.id,
        user.organizationId,
      );

      if (!conversation) {
        return reply.status(404).send({
          error: {
            message: "Conversation not found",
            type: "not_found",
          },
        });
      }

      // Get MCP tools from remote server
      const mcpTools = await getChatMcpTools();

      fastify.log.info(
        {
          conversationId,
          userId: user.id,
          orgId: user.organizationId,
          toolCount: Object.keys(mcpTools).length,
          model: conversation.selectedModel,
        },
        "Starting chat stream",
      );

      // Create OpenAI client
      const openai = createOpenAI({
        apiKey: config.chat.openai.apiKey,
      });

      // Stream with AI SDK
      const result = streamText({
        model: openai(conversation.selectedModel),
        messages: convertToModelMessages(messages),
        tools: mcpTools,
        onFinish: async ({ usage, finishReason }) => {
          fastify.log.info(
            {
              conversationId,
              usage,
              finishReason,
            },
            "Chat stream finished",
          );
        },
      });

      // Return UI message stream response - Fastify handles streaming automatically
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return reply.send(
        result.toUIMessageStreamResponse({
          originalMessages: messages,
          onError: (error) => {
            return JSON.stringify(error);
          },
          onFinish: async ({ messages: finalMessages }) => {
            if (!conversationId) return;

            // Check if last message has empty parts and strip it if so
            let messagesToSave = finalMessages;
            if (
              finalMessages.length > 0 &&
              finalMessages[finalMessages.length - 1].parts.length === 0
            ) {
              messagesToSave = finalMessages.slice(0, -1);
            }

            // Only save if there are messages remaining
            if (messagesToSave.length > 0) {
              // Clear existing messages to avoid duplicates (like desktop app)
              await MessageModel.deleteByConversation(conversationId);

              // Save messages with explicit timestamps to preserve order
              const now = Date.now();
              const messageData = messagesToSave.map((msg: any, index) => ({
                conversationId,
                role: msg.role,
                content: msg, // Store entire UIMessage
                createdAt: new Date(now + index), // Preserve order
              }));

              await MessageModel.bulkCreate(messageData);

              fastify.log.info(
                `Saved ${messagesToSave.length} messages to conversation ${conversationId}`,
              );
            }
          },
        }) as any,
      );
    },
  );

  // ========== Conversations CRUD ==========

  // List conversations
  fastify.get(
    "/api/chat/conversations",
    {
      schema: {
        operationId: RouteId.GetChatConversations,
        description: "List all conversations for current user",
        tags: ["Chat"],
        response: {
          200: z.array(SelectConversationSchema),
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const conversations = await ConversationModel.findAll(
        user.id,
        user.organizationId,
      );
      return reply.send(conversations);
    },
  );

  // Get conversation with messages
  fastify.get(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.GetChatConversation,
        description: "Get conversation with messages",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: {
          200: SelectConversationWithMessagesSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const conversation = await ConversationModel.findByIdWithMessages(
        request.params.id,
        user.id,
        user.organizationId,
      );

      if (!conversation) {
        return reply.status(404).send({
          error: {
            message: "Conversation not found",
            type: "not_found",
          },
        });
      }

      return reply.send(conversation);
    },
  );

  // Create conversation
  fastify.post(
    "/api/chat/conversations",
    {
      schema: {
        operationId: RouteId.CreateChatConversation,
        description: "Create a new conversation",
        tags: ["Chat"],
        body: InsertConversationSchema.pick({
          title: true,
          selectedModel: true,
        }).partial(),
        response: {
          200: SelectConversationSchema,
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: user.organizationId,
        title: request.body.title,
        selectedModel: request.body.selectedModel || config.chat.defaultModel,
      });

      return reply.send(conversation);
    },
  );

  // Update conversation
  fastify.patch(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.UpdateChatConversation,
        description: "Update conversation title or model",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateConversationSchema,
        response: {
          200: SelectConversationSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const conversation = await ConversationModel.update(
        request.params.id,
        user.id,
        user.organizationId,
        request.body,
      );

      if (!conversation) {
        return reply.status(404).send({
          error: {
            message: "Conversation not found",
            type: "not_found",
          },
        });
      }

      return reply.send(conversation);
    },
  );

  // Delete conversation
  fastify.delete(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.DeleteChatConversation,
        description: "Delete a conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: {
          200: z.object({ success: z.boolean() }),
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      await ConversationModel.delete(
        request.params.id,
        user.id,
        user.organizationId,
      );

      return reply.send({ success: true });
    },
  );
};

export default chatRoutes;
