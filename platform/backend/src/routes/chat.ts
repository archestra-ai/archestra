import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  EXTERNAL_AGENT_ID_HEADER,
  RouteId,
  SupportedProviders,
  USER_ID_HEADER,
} from "@shared";
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
  ChatApiKeyModel,
  ConversationEnabledToolModel,
  ConversationModel,
  MessageModel,
  PromptModel,
} from "@/models";
import { getExternalAgentId } from "@/routes/proxy/utils/external-agent-id";
import { isVertexAiEnabled } from "@/routes/proxy/utils/gemini-client";
import {
  getSecretValueForLlmProviderApiKey,
  secretManager,
} from "@/secretsmanager";
import type { SupportedChatProvider } from "@/types";
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

/**
 * Detect which provider a model belongs to based on its name
 */
function detectProviderFromModel(model: string): SupportedChatProvider {
  const lowerModel = model.toLowerCase();

  if (lowerModel.includes("claude")) {
    return "anthropic";
  }

  if (lowerModel.includes("gemini") || lowerModel.includes("google")) {
    return "gemini";
  }

  if (
    lowerModel.includes("gpt") ||
    lowerModel.includes("o1") ||
    lowerModel.includes("o3")
  ) {
    return "openai";
  }

  // Default to anthropic for backwards compatibility
  return "anthropic";
}

/**
 * Get a smart default model based on available API keys for the agent/organization.
 * Priority: profile-specific key > org default key > env var > fallback
 */
async function getSmartDefaultModel(
  agentId: string,
  organizationId: string,
): Promise<string> {
  /**
   * Check what API keys are available (profile-specific or org defaults)
   * Try to find an available API key in order of preference
   */
  for (const provider of SupportedProviders) {
    const profileApiKey = await ChatApiKeyModel.getProfileApiKey(
      agentId,
      provider,
      organizationId,
    );

    if (profileApiKey?.secretId) {
      const secretValue = await getSecretValueForLlmProviderApiKey(
        profileApiKey.secretId,
      );

      if (secretValue) {
        // Found a valid API key for this provider - return appropriate default model
        switch (provider) {
          case "anthropic":
            return "claude-opus-4-1-20250805";
          case "gemini":
            return "gemini-2.5-pro";
          case "openai":
            return "gpt-4o";
        }
      }
    }
  }

  // Check environment variables as fallback
  if (config.chat.anthropic.apiKey) {
    return "claude-opus-4-1-20250805";
  }
  if (config.chat.openai.apiKey) {
    return "gpt-4o";
  }
  if (config.chat.gemini.apiKey) {
    return "gemini-2.5-pro";
  }

  // Check if Vertex AI is enabled - use Gemini without API key
  if (isVertexAiEnabled()) {
    return "gemini-2.5-pro";
  }

  // Ultimate fallback - use configured default
  return config.chat.defaultModel;
}

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

      // Fetch enabled tool IDs, MCP tools, and agent prompts in parallel
      const [enabledToolIds, prompt] = await Promise.all([
        ConversationEnabledToolModel.findByConversation(conversationId),
        PromptModel.findById(conversation.promptId),
      ]);

      // Fetch MCP tools with enabled tool filtering
      const mcpTools = await getChatMcpTools({
        agentName: conversation.agent.name,
        agentId: conversation.agentId,
        userId: user.id,
        userIsProfileAdmin,
        enabledToolIds,
      });

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

      // Detect provider from model name
      const provider = detectProviderFromModel(conversation.selectedModel);

      logger.info(
        {
          conversationId,
          agentId: conversation.agentId,
          userId: user.id,
          orgId: organizationId,
          toolCount: Object.keys(mcpTools).length,
          model: conversation.selectedModel,
          provider,
          promptId: prompt?.id,
          hasSystemPromptParts: systemPromptParts.length > 0,
          hasUserPromptParts: userPromptParts.length > 0,
          systemPromptProvided: !!systemPrompt,
          externalAgentId,
        },
        "Starting chat stream",
      );

      // Resolve API key: profile-specific -> org default -> env var
      let providerApiKey: string | undefined;
      let apiKeySource = "environment";

      // Try profile-specific API key first (getProfileApiKey already falls back to org default)
      const profileApiKey = await ChatApiKeyModel.getProfileApiKey(
        conversation.agentId,
        provider,
        organizationId,
      );

      if (profileApiKey?.secretId) {
        const secret = await secretManager().getSecret(profileApiKey.secretId);
        // Support both old format (anthropicApiKey) and new format (apiKey)
        const secretValue =
          secret?.secret?.apiKey ??
          secret?.secret?.anthropicApiKey ??
          secret?.secret?.geminiApiKey ??
          secret?.secret?.openaiApiKey;
        if (secretValue) {
          providerApiKey = secretValue as string;
          apiKeySource = profileApiKey.isOrganizationDefault
            ? "organization default"
            : "profile-specific";
        }
      }

      // If profileApiKey exists but has no secretId, or getProfileApiKey returned null,
      // explicitly try organization default as a fallback
      if (!providerApiKey) {
        const orgDefault = await ChatApiKeyModel.findOrganizationDefault(
          organizationId,
          provider,
        );
        if (orgDefault?.secretId) {
          const secret = await secretManager().getSecret(orgDefault.secretId);
          // Support both old format (anthropicApiKey) and new format (apiKey)
          const secretValue =
            secret?.secret?.apiKey ??
            secret?.secret?.anthropicApiKey ??
            secret?.secret?.geminiApiKey ??
            secret?.secret?.openaiApiKey;
          if (secretValue) {
            providerApiKey = secretValue as string;
            apiKeySource = "organization default";
          }
        }
      }

      // Fall back to environment variable
      if (!providerApiKey) {
        if (provider === "anthropic" && config.chat.anthropic.apiKey) {
          providerApiKey = config.chat.anthropic.apiKey;
          apiKeySource = "environment";
        } else if (provider === "openai" && config.chat.openai.apiKey) {
          providerApiKey = config.chat.openai.apiKey;
          apiKeySource = "environment";
        } else if (provider === "gemini" && config.chat.gemini.apiKey) {
          providerApiKey = config.chat.gemini.apiKey;
          apiKeySource = "environment";
        }
      }

      // For Gemini with Vertex AI enabled, API key is not required
      // The LLM Proxy handles authentication via ADC
      const isGeminiWithVertexAi = provider === "gemini" && isVertexAiEnabled();

      logger.info(
        { apiKeySource, provider, isGeminiWithVertexAi },
        "Using LLM provider API key",
      );

      if (!providerApiKey && !isGeminiWithVertexAi) {
        throw new ApiError(
          400,
          "LLM Provider API key not configured. Please configure it in Chat Settings.",
        );
      }

      // Create provider client pointing to LLM Proxy
      // Forward external agent ID and user ID headers to LLM Proxy
      // so interactions can be properly associated with the user
      const clientHeaders: Record<string, string> = {};
      if (externalAgentId) {
        clientHeaders[EXTERNAL_AGENT_ID_HEADER] = externalAgentId;
      }
      // Always include user ID header so interactions are saved with user association
      clientHeaders[USER_ID_HEADER] = user.id;

      let llmClient:
        | ReturnType<typeof createAnthropic>
        | ReturnType<typeof createGoogleGenerativeAI>
        | ReturnType<typeof createOpenAI>;

      if (provider === "anthropic") {
        // URL format: /v1/anthropic/:agentId/v1/messages
        llmClient = createAnthropic({
          apiKey: providerApiKey,
          baseURL: `http://localhost:${config.api.port}/v1/anthropic/${conversation.agentId}/v1`,
          headers:
            Object.keys(clientHeaders).length > 0 ? clientHeaders : undefined,
        });
      } else if (provider === "gemini") {
        // URL format: /v1/gemini/:agentId/v1beta/models
        // For Vertex AI mode, pass a placeholder - the LLM Proxy uses ADC for auth
        llmClient = createGoogleGenerativeAI({
          apiKey: providerApiKey || "vertex-ai-mode",
          baseURL: `http://localhost:${config.api.port}/v1/gemini/${conversation.agentId}/v1beta`,
          headers:
            Object.keys(clientHeaders).length > 0 ? clientHeaders : undefined,
        });
      } else if (provider === "openai") {
        // URL format: /v1/openai/:agentId (SDK appends /chat/completions)
        llmClient = createOpenAI({
          apiKey: providerApiKey,
          baseURL: `http://localhost:${config.api.port}/v1/openai/${conversation.agentId}`,
          headers:
            Object.keys(clientHeaders).length > 0 ? clientHeaders : undefined,
        });
      } else {
        throw new ApiError(400, `Unsupported provider: ${provider}`);
      }

      // Stream with AI SDK
      // Build streamText config conditionally
      const streamTextConfig: Parameters<typeof streamText>[0] = {
        model: llmClient(conversation.selectedModel),
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
      const mcpTools = await getChatMcpTools({
        agentName: agent.name,
        agentId,
        userId: user.id,
        userIsProfileAdmin: isAgentAdmin,
      });

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

      // Determine smart default model if none specified
      const modelToUse =
        selectedModel || (await getSmartDefaultModel(agentId, organizationId));

      logger.info(
        {
          agentId,
          organizationId,
          selectedModel,
          modelToUse,
          wasSmartDefault: !selectedModel,
        },
        "Creating conversation with model",
      );

      // Create conversation with agent and optional prompt
      return reply.send(
        await ConversationModel.create({
          userId: user.id,
          organizationId,
          agentId,
          promptId,
          title,
          selectedModel: modelToUse,
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

      // Resolve API key: profile-specific -> org default -> env var
      let anthropicApiKey: string | undefined;

      // Try profile-specific API key first (if conversation has an agent)
      if (conversation.agentId) {
        const profileApiKey = await ChatApiKeyModel.getProfileApiKey(
          conversation.agentId,
          "anthropic",
          organizationId,
        );

        if (profileApiKey?.secretId) {
          const secret = await secretManager().getSecret(
            profileApiKey.secretId,
          );
          // Support both old format (anthropicApiKey) and new format (apiKey)
          const secretValue =
            secret?.secret?.apiKey ?? secret?.secret?.anthropicApiKey;
          if (secretValue) {
            anthropicApiKey = secretValue as string;
          }
        }
      }

      // If profileApiKey doesn't work, explicitly try organization default as a fallback
      if (!anthropicApiKey) {
        const orgDefault = await ChatApiKeyModel.findOrganizationDefault(
          organizationId,
          "anthropic",
        );
        if (orgDefault?.secretId) {
          const secret = await secretManager().getSecret(orgDefault.secretId);
          // Support both old format (anthropicApiKey) and new format (apiKey)
          const secretValue =
            secret?.secret?.apiKey ?? secret?.secret?.anthropicApiKey;
          if (secretValue) {
            anthropicApiKey = secretValue as string;
          }
        }
      }

      // Fall back to environment variable
      if (!anthropicApiKey) {
        anthropicApiKey = config.chat.anthropic.apiKey;
      }

      if (!anthropicApiKey) {
        throw new ApiError(
          400,
          "LLM Provider API key not configured. Please configure it in Chat Settings.",
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

  // Enabled Tools Routes
  fastify.get(
    "/api/chat/conversations/:id/enabled-tools",
    {
      schema: {
        operationId: RouteId.GetConversationEnabledTools,
        description:
          "Get enabled tools for a conversation. Empty array means all profile tools are enabled (default).",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(
          z.object({
            hasCustomSelection: z.boolean(),
            enabledToolIds: z.array(z.string()),
          }),
        ),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      // Verify conversation exists and user owns it
      const conversation = await ConversationModel.findById(
        id,
        user.id,
        organizationId,
      );

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      const [hasCustomSelection, enabledToolIds] = await Promise.all([
        ConversationEnabledToolModel.hasCustomSelection(id),
        ConversationEnabledToolModel.findByConversation(id),
      ]);

      return reply.send({
        hasCustomSelection,
        enabledToolIds,
      });
    },
  );

  fastify.put(
    "/api/chat/conversations/:id/enabled-tools",
    {
      schema: {
        operationId: RouteId.UpdateConversationEnabledTools,
        description:
          "Set enabled tools for a conversation. Replaces all existing selections.",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: z.object({
          toolIds: z.array(z.string()),
        }),
        response: constructResponseSchema(
          z.object({
            hasCustomSelection: z.boolean(),
            enabledToolIds: z.array(z.string()),
          }),
        ),
      },
    },
    async (
      { params: { id }, body: { toolIds }, user, organizationId },
      reply,
    ) => {
      // Verify conversation exists and user owns it
      const conversation = await ConversationModel.findById(
        id,
        user.id,
        organizationId,
      );

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      await ConversationEnabledToolModel.setEnabledTools(id, toolIds);

      return reply.send({
        hasCustomSelection: toolIds.length > 0,
        enabledToolIds: toolIds,
      });
    },
  );

  fastify.delete(
    "/api/chat/conversations/:id/enabled-tools",
    {
      schema: {
        operationId: RouteId.DeleteConversationEnabledTools,
        description:
          "Clear custom tool selection for a conversation (revert to all tools enabled)",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      // Verify conversation exists and user owns it
      const conversation = await ConversationModel.findById(
        id,
        user.id,
        organizationId,
      );

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      await ConversationEnabledToolModel.clearCustomSelection(id);

      return reply.send({ success: true });
    },
  );
};

export default chatRoutes;
