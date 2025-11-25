import { createAnthropic } from "@ai-sdk/anthropic";
import { RouteId } from "@shared";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { getChatMcpTools } from "@/clients/chat-mcp-client";
import config from "@/config";
import {
  AgentModel,
  ChatSettingsModel,
  ConversationModel,
  MessageModel,
  PromptModel,
  SecretModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ErrorResponsesSchema,
  InsertConversationSchema,
  SelectConversationSchema,
  UpdateConversationSchema,
  UuidIdSchema,
} from "@/types";

const chatRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/chat",
    {
      schema: {
        operationId: RouteId.StreamChat,
        description: "Stream chat response with MCP tools (useChat format)",
        tags: ["Chat"],
        body: z.object({
          id: UuidIdSchema, // Chat ID from useChat
          messages: z.array(z.any()), // UIMessage[]
          trigger: z.enum(["submit-message", "regenerate-message"]).optional(),
        }),
        // Streaming responses don't have a schema
        response: ErrorResponsesSchema,
      },
    },
    async (
      { body: { id: conversationId, messages }, user, organizationId },
      reply,
    ) => {
      // Get conversation
      const conversation = await ConversationModel.findById(
        conversationId,
        user.id,
        organizationId,
      );

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      // Fetch MCP tools, agent prompts, and chat settings in parallel
      const [mcpTools, prompts, chatSettings] = await Promise.all([
        getChatMcpTools(conversation.agentId),
        PromptModel.findByAgentId(conversation.agentId),
        ChatSettingsModel.findByOrganizationId(organizationId),
      ]);

      // Build system prompt from prompts' systemPrompt and userPrompt fields
      let systemPrompt: string | undefined;
      const systemPromptParts: string[] = [];
      const userPromptParts: string[] = [];

      // Collect system and user prompts from all assigned prompts
      for (const prompt of prompts) {
        if (prompt.systemPrompt) {
          systemPromptParts.push(prompt.systemPrompt);
        }
        if (prompt.userPrompt) {
          userPromptParts.push(prompt.userPrompt);
        }
      }

      // Combine all prompts into system prompt (system prompts first, then user prompts)
      if (systemPromptParts.length > 0 || userPromptParts.length > 0) {
        const allParts = [...systemPromptParts, ...userPromptParts];
        systemPrompt = allParts.join("\n\n");
      }

      fastify.log.info(
        {
          conversationId,
          agentId: conversation.agentId,
          userId: user.id,
          orgId: organizationId,
          toolCount: Object.keys(mcpTools).length,
          model: conversation.selectedModel,
          promptsCount: prompts.length,
          hasSystemPromptParts: systemPromptParts.length > 0,
          hasUserPromptParts: userPromptParts.length > 0,
          systemPromptProvided: !!systemPrompt,
        },
        "Starting chat stream",
      );

      let anthropicApiKey = config.chat.anthropic.apiKey; // Fallback to env var

      if (chatSettings?.anthropicApiKeySecretId) {
        const secret = await SecretModel.findById(
          chatSettings.anthropicApiKeySecretId,
        );
        if (secret?.secret?.anthropicApiKey) {
          anthropicApiKey = secret.secret.anthropicApiKey as string;
          fastify.log.info("Using Anthropic API key from database");
        }
      } else {
        fastify.log.info("Using Anthropic API key from environment variable");
      }

      if (!anthropicApiKey) {
        throw new ApiError(
          400,
          "Anthropic API key not configured. Please configure it in Chat Settings.",
        );
      }

      // Create Anthropic client pointing to LLM Proxy
      // URL format: /v1/anthropic/:agentId/v1/messages
      const anthropic = createAnthropic({
        apiKey: anthropicApiKey,
        baseURL: `http://localhost:${config.api.port}/v1/anthropic/${conversation.agentId}/v1`,
      });

      // Stream with AI SDK
      const result = streamText({
        model: anthropic(conversation.selectedModel),
        system: systemPrompt,
        messages: convertToModelMessages(messages),
        tools: mcpTools,
        stopWhen: stepCountIs(20),
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

      // Convert to UI message stream response (Response object)
      const response = result.toUIMessageStreamResponse({
        headers: {
          // Prevent compression middleware from buffering the stream
          // See: https://ai-sdk.dev/docs/troubleshooting/streaming-not-working-when-proxied
          "Content-Encoding": "none",
        },
        originalMessages: messages,
        onError: (error) => {
          fastify.log.error(
            { error, conversationId, agentId: conversation.agentId },
            "Chat stream error occurred",
          );

          // Return full error as JSON string for debugging
          try {
            const fullError = JSON.stringify(error, null, 2);
            fastify.log.info(
              { fullError, willBeSentToFrontend: true },
              "Returning full error to frontend via stream",
            );
            return fullError;
          } catch (stringifyError) {
            // If stringify fails (circular reference), fall back to error message
            const fallbackMessage =
              error instanceof Error ? error.message : String(error);
            fastify.log.info(
              { fallbackMessage, stringifyError },
              "Failed to stringify error, using fallback",
            );
            return fallbackMessage;
          }
        },
        onFinish: async ({ messages: finalMessages }) => {
          if (!conversationId) return;

          // Get existing messages count to know how many are new
          const existingMessages =
            await MessageModel.findByConversation(conversationId);
          const existingCount = existingMessages.length;

          // Only save new messages (avoid re-saving existing ones)
          const newMessages = finalMessages.slice(existingCount);

          if (newMessages.length > 0) {
            // Check if last message has empty parts and strip it if so
            let messagesToSave = newMessages;
            if (
              newMessages.length > 0 &&
              newMessages[newMessages.length - 1].parts.length === 0
            ) {
              messagesToSave = newMessages.slice(0, -1);
            }

            if (messagesToSave.length > 0) {
              // Append only new messages with timestamps
              const now = Date.now();
              // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
              const messageData = messagesToSave.map((msg: any, index) => ({
                conversationId,
                role: msg.role,
                content: msg, // Store entire UIMessage
                createdAt: new Date(now + index), // Preserve order
              }));

              await MessageModel.bulkCreate(messageData);

              fastify.log.info(
                `Appended ${messagesToSave.length} new messages to conversation ${conversationId} (total: ${existingCount + messagesToSave.length})`,
              );
            }
          }
        },
      });

      // Log response headers for debugging
      fastify.log.info(
        {
          conversationId,
          headers: Object.fromEntries(response.headers.entries()),
          hasBody: !!response.body,
        },
        "Streaming chat response",
      );

      // Copy headers from Response to Fastify reply
      for (const [key, value] of response.headers.entries()) {
        reply.header(key, value);
      }

      // Send the Response body stream directly
      if (!response.body) {
        throw new ApiError(400, "No response body");
      }
      // biome-ignore lint/suspicious/noExplicitAny: Fastify reply.send accepts ReadableStream but TypeScript requires explicit cast
      return reply.send(response.body as any);
    },
  );

  fastify.get(
    "/api/chat/conversations",
    {
      schema: {
        operationId: RouteId.GetChatConversations,
        description:
          "List all conversations for current user with agent details",
        tags: ["Chat"],
        response: constructResponseSchema(z.array(SelectConversationSchema)),
      },
    },
    async (request, reply) => {
      return reply.send(
        await ConversationModel.findAll(
          request.user.id,
          request.organizationId,
        ),
      );
    },
  );

  fastify.get(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.GetChatConversation,
        description: "Get conversation with messages",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const conversation = await ConversationModel.findById(
        id,
        user.id,
        organizationId,
      );

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      return reply.send(conversation);
    },
  );

  fastify.get(
    "/api/chat/agents/:agentId/mcp-tools",
    {
      schema: {
        operationId: RouteId.GetChatAgentMcpTools,
        description: "Get MCP tools available for an agent via MCP Gateway",
        tags: ["Chat"],
        params: z.object({ agentId: UuidIdSchema }),
        response: constructResponseSchema(
          z.array(
            z.object({
              name: z.string(),
              description: z.string(),
              parameters: z.record(z.string(), z.any()).nullable(),
            }),
          ),
        ),
      },
    },
    async ({ params: { agentId }, user, headers }, reply) => {
      // Check if user is an agent admin
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      // Verify agent exists and user has access
      const agent = await AgentModel.findById(agentId, user.id, isAgentAdmin);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Fetch MCP tools from gateway (same as used in chat)
      const mcpTools = await getChatMcpTools(agentId);

      // Convert AI SDK Tool format to simple array for frontend
      const tools = Object.entries(mcpTools).map(([name, tool]) => ({
        name,
        description: tool.description || "",
        parameters:
          (tool.inputSchema as { jsonSchema?: Record<string, unknown> })
            ?.jsonSchema || null,
      }));

      return reply.send(tools);
    },
  );

  fastify.post(
    "/api/chat/conversations",
    {
      schema: {
        operationId: RouteId.CreateChatConversation,
        description: "Create a new conversation with an agent",
        tags: ["Chat"],
        body: InsertConversationSchema.pick({
          agentId: true,
          title: true,
          selectedModel: true,
        })
          .required({ agentId: true })
          .partial({ title: true, selectedModel: true }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async (
      {
        body: { agentId, title, selectedModel },
        user,
        organizationId,
        headers,
      },
      reply,
    ) => {
      // Check if user is an agent admin
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      // Validate that the agent exists and user has access to it
      const agent = await AgentModel.findById(agentId, user.id, isAgentAdmin);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // Create conversation with agent
      return reply.send(
        await ConversationModel.create({
          userId: user.id,
          organizationId,
          agentId,
          title,
          selectedModel: selectedModel || config.chat.defaultModel,
        }),
      );
    },
  );

  fastify.patch(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.UpdateChatConversation,
        description: "Update conversation title or model",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateConversationSchema,
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const conversation = await ConversationModel.update(
        id,
        user.id,
        organizationId,
        body,
      );

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      return reply.send(conversation);
    },
  );

  fastify.delete(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.DeleteChatConversation,
        description: "Delete a conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      await ConversationModel.delete(id, user.id, organizationId);
      return reply.send({ success: true });
    },
  );
};

export default chatRoutes;
