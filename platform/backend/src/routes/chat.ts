import { createAnthropic } from "@ai-sdk/anthropic";
import { EXTERNAL_AGENT_ID_HEADER, RouteId } from "@shared";
import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  streamText,
} from "ai";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { getChatMcpTools } from "@/clients/chat-mcp-client";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  ChatSettingsModel,
  ConversationModel,
  MessageModel,
  PromptModel,
} from "@/models";
import { getExternalAgentId } from "@/routes/proxy/utils/external-agent-id";
import { secretManager } from "@/secretsmanager";
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
      { body: { id: conversationId, messages }, user, organizationId, headers },
      reply,
    ) => {
      const { success: userIsProfileAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      // Extract external agent ID from incoming request headers to forward to LLM Proxy
      const externalAgentId = getExternalAgentId(headers);

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
      const [mcpTools, prompt, chatSettings] = await Promise.all([
        getChatMcpTools(conversation.agentId, user.id, userIsProfileAdmin),
        PromptModel.findById(conversation.promptId),
        ChatSettingsModel.findByOrganizationId(organizationId),
      ]);

      // Build system prompt from prompts' systemPrompt and userPrompt fields
      let systemPrompt: string | undefined;
      const systemPromptParts: string[] = [];
      const userPromptParts: string[] = [];

      // Collect system and user prompts from all assigned prompts
      if (prompt?.systemPrompt) {
        systemPromptParts.push(prompt.systemPrompt);
      }
      if (prompt?.userPrompt) {
        userPromptParts.push(prompt.userPrompt);
      }

      // Combine all prompts into system prompt (system prompts first, then user prompts)
      if (systemPromptParts.length > 0 || userPromptParts.length > 0) {
        const allParts = [...systemPromptParts, ...userPromptParts];
        systemPrompt = allParts.join("\n\n");
      }

      logger.info(
        {
          conversationId,
          agentId: conversation.agentId,
          userId: user.id,
          orgId: organizationId,
          toolCount: Object.keys(mcpTools).length,
          model: conversation.selectedModel,
          promptId: prompt?.id,
          hasSystemPromptParts: systemPromptParts.length > 0,
          hasUserPromptParts: userPromptParts.length > 0,
          systemPromptProvided: !!systemPrompt,
          externalAgentId,
        },
        "Starting chat stream",
      );

      let anthropicApiKey = config.chat.anthropic.apiKey; // Fallback to env var

      if (chatSettings?.anthropicApiKeySecretId) {
        const secret = await secretManager.getSecret(
          chatSettings.anthropicApiKeySecretId,
        );
        if (secret?.secret?.anthropicApiKey) {
          anthropicApiKey = secret.secret.anthropicApiKey as string;
          logger.info("Using Anthropic API key from database");
        }
      } else {
        logger.info("Using Anthropic API key from environment variable");
      }

      if (!anthropicApiKey) {
        throw new ApiError(
          400,
          "Anthropic API key not configured. Please configure it in Chat Settings.",
        );
      }

      // Create Anthropic client pointing to LLM Proxy
      // URL format: /v1/anthropic/:agentId/v1/messages
      // Forward external agent ID header if present
      const anthropic = createAnthropic({
        apiKey: anthropicApiKey,
        baseURL: `http://localhost:${config.api.port}/v1/anthropic/${conversation.agentId}/v1`,
        headers: externalAgentId
          ? {
              [EXTERNAL_AGENT_ID_HEADER]: externalAgentId,
            }
          : undefined,
      });

      // Stream with AI SDK
      // Build streamText config conditionally
      const streamTextConfig: Parameters<typeof streamText>[0] = {
        model: anthropic(conversation.selectedModel),
        messages: convertToModelMessages(messages),
        tools: mcpTools,
        stopWhen: stepCountIs(20),
        onFinish: async ({ usage, finishReason }) => {
          logger.info(
            {
              conversationId,
              usage,
              finishReason,
            },
            "Chat stream finished",
          );
        },
      };

      // Only include system property if we have actual content
      if (systemPrompt) {
        streamTextConfig.system = systemPrompt;
      }

      const result = streamText(streamTextConfig);

      // Convert to UI message stream response (Response object)
      const response = result.toUIMessageStreamResponse({
        headers: {
          // Prevent compression middleware from buffering the stream
          // See: https://ai-sdk.dev/docs/troubleshooting/streaming-not-working-when-proxied
          "Content-Encoding": "none",
        },
        originalMessages: messages,
        onError: (error) => {
          logger.error(
            { error, conversationId, agentId: conversation.agentId },
            "Chat stream error occurred",
          );

          // Return full error as JSON string for debugging
          try {
            const fullError = JSON.stringify(error, null, 2);
            logger.info(
              { fullError, willBeSentToFrontend: true },
              "Returning full error to frontend via stream",
            );
            return fullError;
          } catch (stringifyError) {
            // If stringify fails (circular reference), fall back to error message
            const fallbackMessage =
              error instanceof Error ? error.message : String(error);
            logger.info(
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

              logger.info(
                `Appended ${messagesToSave.length} new messages to conversation ${conversationId} (total: ${existingCount + messagesToSave.length})`,
              );
            }
          }
        },
      });

      // Log response headers for debugging
      logger.info(
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
        return [];
      }

      // Fetch MCP tools from gateway (same as used in chat)
      const mcpTools = await getChatMcpTools(agentId, user.id, isAgentAdmin);

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
          promptId: true,
          title: true,
          selectedModel: true,
        })
          .required({ agentId: true })
          .partial({ promptId: true, title: true, selectedModel: true }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async (
      {
        body: { agentId, promptId, title, selectedModel },
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

      // Create conversation with agent and optional prompt
      return reply.send(
        await ConversationModel.create({
          userId: user.id,
          organizationId,
          agentId,
          promptId,
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

  fastify.post(
    "/api/chat/conversations/:id/generate-title",
    {
      schema: {
        operationId: RouteId.GenerateChatConversationTitle,
        description:
          "Generate a title for the conversation based on the first user message and assistant response",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: z
          .object({
            regenerate: z
              .boolean()
              .optional()
              .describe(
                "Force regeneration even if title already exists (for manual regeneration)",
              ),
          })
          .optional(),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const regenerate = body?.regenerate ?? false;

      // Get conversation with messages
      const conversation = await ConversationModel.findById(
        id,
        user.id,
        organizationId,
      );

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      // Skip if title is already set (unless regenerating)
      if (conversation.title && !regenerate) {
        logger.info(
          { conversationId: id, existingTitle: conversation.title },
          "Skipping title generation - title already set",
        );
        return reply.send(conversation);
      }

      // Extract first user message and first assistant message text
      const messages = conversation.messages || [];
      let firstUserMessage = "";
      let firstAssistantMessage = "";

      for (const msg of messages) {
        // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
        const msgContent = msg as any;
        if (!firstUserMessage && msgContent.role === "user") {
          // Extract text from parts
          for (const part of msgContent.parts || []) {
            if (part.type === "text" && part.text) {
              firstUserMessage = part.text;
              break;
            }
          }
        }
        if (!firstAssistantMessage && msgContent.role === "assistant") {
          // Extract text from parts (skip tool calls)
          for (const part of msgContent.parts || []) {
            if (part.type === "text" && part.text) {
              firstAssistantMessage = part.text;
              break;
            }
          }
        }
        if (firstUserMessage && firstAssistantMessage) break;
      }

      // Need at least user message to generate title
      if (!firstUserMessage) {
        logger.info(
          { conversationId: id },
          "Skipping title generation - no user message found",
        );
        return reply.send(conversation);
      }

      // Get Anthropic API key
      const chatSettings =
        await ChatSettingsModel.findByOrganizationId(organizationId);
      let anthropicApiKey = config.chat.anthropic.apiKey;
      if (chatSettings?.anthropicApiKeySecretId) {
        const secret = await secretManager.getSecret(
          chatSettings.anthropicApiKeySecretId,
        );
        if (secret?.secret?.anthropicApiKey) {
          anthropicApiKey = secret.secret.anthropicApiKey as string;
        }
      }

      if (!anthropicApiKey) {
        throw new ApiError(
          400,
          "Anthropic API key not configured. Please configure it in Chat Settings.",
        );
      }

      // Create Anthropic client (direct, not through LLM proxy - this is a meta operation)
      const anthropic = createAnthropic({
        apiKey: anthropicApiKey,
      });

      // Build prompt for title generation
      const contextMessages = firstAssistantMessage
        ? `User: ${firstUserMessage}\n\nAssistant: ${firstAssistantMessage}`
        : `User: ${firstUserMessage}`;

      const titlePrompt = `Generate a short, concise title (3-6 words) for a chat conversation that includes the following messages:

${contextMessages}

The title should capture the main topic or theme of the conversation. Respond with ONLY the title, no quotes, no explanation. DON'T WRAP THE TITLE IN QUOTES!!!`;

      try {
        // Generate title using a fast model
        const result = await generateText({
          model: anthropic("claude-3-5-haiku-20241022"),
          prompt: titlePrompt,
        });

        const generatedTitle = result.text.trim();

        logger.info(
          { conversationId: id, generatedTitle },
          "Generated conversation title",
        );

        // Update conversation with generated title
        const updatedConversation = await ConversationModel.update(
          id,
          user.id,
          organizationId,
          { title: generatedTitle },
        );

        if (!updatedConversation) {
          throw new ApiError(500, "Failed to update conversation with title");
        }

        return reply.send(updatedConversation);
      } catch (error) {
        logger.error(
          { conversationId: id, error },
          "Failed to generate conversation title",
        );
        // Return the conversation without title update on error
        return reply.send(conversation);
      }
    },
  );
};

export default chatRoutes;
