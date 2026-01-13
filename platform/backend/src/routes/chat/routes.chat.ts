import { createAnthropic } from "@ai-sdk/anthropic";
import { type ChatErrorResponse, RouteId, SupportedProviders } from "@shared";
import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  streamText,
  type UIMessage,
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
  TeamModel,
} from "@/models";
import { getExternalAgentId } from "@/routes/proxy/utils/external-agent-id";
import { isVertexAiEnabled } from "@/routes/proxy/utils/gemini-client";
import {
  getSecretValueForLlmProviderApiKey,
  secretManager,
} from "@/secrets-manager";
import { browserStreamFeature } from "@/services/browser-stream-feature";
import {
  createLLMModelForAgent,
  detectProviderFromModel,
} from "@/services/llm-client";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ErrorResponsesSchema,
  InsertConversationSchema,
  SelectConversationSchema,
  type SupportedChatProvider,
  UpdateConversationSchema,
  UuidIdSchema,
} from "@/types";
import { estimateMessagesSize } from "@/utils/message-size";
import { mapProviderError } from "./errors";
import {
  stripImagesFromMessages,
  type UiMessage,
} from "./strip-images-from-messages";

/**
 * Get a smart default model and provider based on available API keys for the user.
 * Priority: personal key > team key > org-wide key > env var > fallback
 */
async function getSmartDefaultModel(
  userId: string,
  organizationId: string,
): Promise<{ model: string; provider: SupportedChatProvider }> {
  // Get user's team IDs for resolution
  const userTeamIds = await TeamModel.getUserTeamIds(userId);

  /**
   * Check what API keys are available using the new scope-based resolution
   * Try to find an available API key in order of preference
   */
  for (const provider of SupportedProviders) {
    const resolvedKey = await ChatApiKeyModel.getCurrentApiKey({
      organizationId: organizationId,
      userId: userId,
      userTeamIds: userTeamIds,
      provider: provider,
      conversationId: null,
    });

    if (resolvedKey?.secretId) {
      const secretValue = await getSecretValueForLlmProviderApiKey(
        resolvedKey.secretId,
      );

      if (secretValue) {
        // Found a valid API key for this provider - return appropriate default model
        switch (provider) {
          case "anthropic":
            return { model: "claude-opus-4-1-20250805", provider: "anthropic" };
          case "gemini":
            return { model: "gemini-2.5-pro", provider: "gemini" };
          case "openai":
            return { model: "gpt-4o", provider: "openai" };
        }
      }
    }
  }

  // Check environment variables as fallback
  if (config.chat.anthropic.apiKey) {
    return { model: "claude-opus-4-1-20250805", provider: "anthropic" };
  }
  if (config.chat.openai.apiKey) {
    return { model: "gpt-4o", provider: "openai" };
  }
  if (config.chat.gemini.apiKey) {
    return { model: "gemini-2.5-pro", provider: "gemini" };
  }

  // Check if Vertex AI is enabled - use Gemini without API key
  if (isVertexAiEnabled()) {
    logger.info(
      "getSmartDefaultModel:Vertex AI is enabled, using gemini-2.5-pro",
    );
    return { model: "gemini-2.5-pro", provider: "gemini" };
  }

  // Ultimate fallback - use configured defaults
  return {
    model: config.chat.defaultModel,
    provider: config.chat.defaultProvider,
  };
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
          messages: z.array(z.unknown()), // UIMessage[]
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

      // Get conversation
      const conversation = await ConversationModel.findById({
        id: conversationId,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      // Use prompt ID as external agent ID if available, otherwise use header value
      // This allows prompt names to be displayed in LLM proxy logs
      const headerExternalAgentId = getExternalAgentId(headers);
      const externalAgentId = conversation.promptId ?? headerExternalAgentId;

      // Fetch enabled tool IDs, custom selection status, and agent prompts in parallel
      const [enabledToolIds, hasCustomSelection, prompt] = await Promise.all([
        ConversationEnabledToolModel.findByConversation(conversationId),
        ConversationEnabledToolModel.hasCustomSelection(conversationId),
        PromptModel.findById(conversation.promptId),
      ]);

      // Fetch MCP tools with enabled tool filtering
      // Pass undefined if no custom selection (use all tools)
      // Pass the actual array (even if empty) if there is custom selection
      const mcpTools = await getChatMcpTools({
        agentName: conversation.agent.name,
        agentId: conversation.agentId,
        userId: user.id,
        userIsProfileAdmin,
        enabledToolIds: hasCustomSelection ? enabledToolIds : undefined,
        conversationId: conversation.id,
        promptId: conversation.promptId ?? undefined,
        organizationId,
        // Pass conversationId as sessionId to group all chat requests (including delegated agents) together
        sessionId: conversation.id,
        // Pass promptId as initial delegation chain (will be extended by delegated agents)
        delegationChain: conversation.promptId ?? undefined,
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

      // Use stored provider if available, otherwise detect from model name for backward compatibility
      // At the moment of migration, all supported providers (anthropic, openai, gemini) serve different models,
      // so we can safely use detectProviderFromModel for them.
      const provider =
        (conversation.selectedProvider as SupportedChatProvider | null) ??
        detectProviderFromModel(conversation.selectedModel);

      logger.info(
        {
          conversationId,
          agentId: conversation.agentId,
          userId: user.id,
          orgId: organizationId,
          toolCount: Object.keys(mcpTools).length,
          hasCustomToolSelection: hasCustomSelection,
          enabledToolCount: hasCustomSelection ? enabledToolIds.length : "all",
          model: conversation.selectedModel,
          provider,
          providerSource: conversation.selectedProvider ? "stored" : "detected",
          promptId: prompt?.id,
          hasSystemPromptParts: systemPromptParts.length > 0,
          hasUserPromptParts: userPromptParts.length > 0,
          systemPromptProvided: !!systemPrompt,
          externalAgentId,
        },
        "Starting chat stream",
      );

      // Create LLM model using shared service
      // Pass conversationId as sessionId to group all requests in this chat session
      const { model } = await createLLMModelForAgent({
        organizationId,
        userId: user.id,
        agentId: conversation.agentId,
        model: conversation.selectedModel,
        provider,
        conversationId,
        externalAgentId,
        sessionId: conversationId,
      });

      // Strip images and large browser tool results from messages before sending to LLM
      // This prevents context limit issues from accumulated screenshots and page snapshots
      const strippedMessagesForLLM = config.features.browserStreamingEnabled
        ? stripImagesFromMessages(messages as UiMessage[])
        : (messages as UiMessage[]);

      // Stream with AI SDK
      // Build streamText config conditionally
      // Cast to UIMessage[] - UiMessage is structurally compatible at runtime
      const modelMessages = await convertToModelMessages(
        strippedMessagesForLLM as unknown as Omit<UIMessage, "id">[],
      );
      const streamTextConfig: Parameters<typeof streamText>[0] = {
        model,
        messages: modelMessages,
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
        originalMessages: messages as UIMessage[],
        onError: (error) => {
          logger.error(
            { error, conversationId, agentId: conversation.agentId },
            "Chat stream error occurred",
          );

          // Map provider error to user-friendly ChatErrorResponse
          const mappedError: ChatErrorResponse = mapProviderError(
            error,
            provider,
          );

          logger.info(
            {
              mappedError,
              originalErrorType:
                error instanceof Error ? error.name : typeof error,
              willBeSentToFrontend: true,
            },
            "Returning mapped error to frontend via stream",
          );

          // mapProviderError safely serializes raw errors, but add defensive try-catch
          try {
            return JSON.stringify(mappedError);
          } catch (stringifyError) {
            logger.error(
              { stringifyError, errorCode: mappedError.code },
              "Failed to stringify mapped error, returning minimal error",
            );
            // Return a minimal error response without the raw error
            return JSON.stringify({
              code: mappedError.code,
              message: mappedError.message,
              isRetryable: mappedError.isRetryable,
            });
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
              let messagesToStore = messagesToSave as UiMessage[];

              if (config.features.browserStreamingEnabled) {
                // Strip base64 images and large browser tool results before storing
                const beforeSize = estimateMessagesSize(messagesToSave);
                messagesToStore = stripImagesFromMessages(
                  messagesToSave as UiMessage[],
                );
                const afterSize = estimateMessagesSize(messagesToStore);

                logger.info(
                  {
                    messageCount: messagesToSave.length,
                    beforeSizeKB: Math.round(beforeSize.length / 1024),
                    afterSizeKB: Math.round(afterSize.length / 1024),
                    savedKB: Math.round(
                      (beforeSize.length - afterSize.length) / 1024,
                    ),
                    sizeEstimateReliable:
                      !beforeSize.isEstimated && !afterSize.isEstimated,
                  },
                  "[Chat] Stripped messages before saving to DB",
                );
              }

              // Append only new messages with timestamps
              const now = Date.now();
              const messageData = messagesToStore.map((msg, index) => ({
                conversationId,
                role: msg.role ?? "assistant",
                content: msg, // Store entire UIMessage (with images stripped)
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
      const conversation = await ConversationModel.findById({
        id: id,
        userId: user.id,
        organizationId: organizationId,
      });

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
        // No conversation context here as this is just fetching available tools
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
          selectedProvider: true,
          chatApiKeyId: true,
        })
          .required({ agentId: true })
          .partial({
            promptId: true,
            title: true,
            selectedModel: true,
            selectedProvider: true,
            chatApiKeyId: true,
          }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async (
      {
        body: {
          agentId,
          promptId,
          title,
          selectedModel,
          selectedProvider,
          chatApiKeyId,
        },
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

      // Validate chatApiKeyId if provided
      if (chatApiKeyId) {
        await validateChatApiKeyAccess(chatApiKeyId, user.id, organizationId);
      }

      // Determine model and provider to use
      // If frontend provides both, use them; otherwise use smart defaults
      let modelToUse = selectedModel;
      let providerToUse = selectedProvider;

      if (!selectedModel) {
        // No model specified - use smart defaults for both model and provider
        const smartDefault = await getSmartDefaultModel(
          user.id,
          organizationId,
        );
        modelToUse = smartDefault.model;
        providerToUse = smartDefault.provider;
      } else if (!selectedProvider) {
        // Model specified but no provider - detect provider from model name
        // This handles older API clients that don't send selectedProvider
        // It's a rare case which should happen only for a case when backend already has a provider selection logic, but frontend is stale.
        // In other words, it's a backward compatibility case which should happen only for a very short period of time.
        providerToUse = detectProviderFromModel(selectedModel);
      }

      logger.info(
        {
          agentId,
          organizationId,
          selectedModel,
          selectedProvider,
          modelToUse,
          providerToUse,
          chatApiKeyId,
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
          selectedProvider: providerToUse,
          chatApiKeyId,
        }),
      );
    },
  );

  fastify.patch(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.UpdateChatConversation,
        description: "Update conversation title, model, agent, or API key",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateConversationSchema,
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId, headers }, reply) => {
      // Validate chatApiKeyId if provided
      if (body.chatApiKeyId) {
        await validateChatApiKeyAccess(
          body.chatApiKeyId,
          user.id,
          organizationId,
        );
      }

      // Validate agentId if provided
      if (body.agentId) {
        const { success: isAgentAdmin } = await hasPermission(
          { profile: ["admin"] },
          headers,
        );

        const agent = await AgentModel.findById(
          body.agentId,
          user.id,
          isAgentAdmin,
        );
        if (!agent) {
          throw new ApiError(404, "Agent not found");
        }
      }

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
      // Get conversation to retrieve agentId before deletion
      const conversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });

      if (conversation && browserStreamFeature.isEnabled()) {
        // Close browser tab for this conversation (best effort, don't fail if it errors)
        try {
          await browserStreamFeature.closeTab(conversation.agentId, id, {
            userId: user.id,
            userIsProfileAdmin: false,
          });
        } catch (error) {
          logger.warn(
            { error, conversationId: id },
            "Failed to close browser tab on conversation deletion",
          );
        }
      }

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
      const conversation = await ConversationModel.findById({
        id: id,
        userId: user.id,
        organizationId: organizationId,
      });

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

      // Resolve API key using scope-based priority: personal -> team -> org_wide -> env var
      let anthropicApiKey: string | undefined;

      // Get user's team IDs for resolution
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      // Use resolveApiKey which handles priority: conversation key -> personal -> team -> org_wide
      const resolvedKey = await ChatApiKeyModel.getCurrentApiKey({
        organizationId: organizationId,
        userId: user.id,
        userTeamIds: userTeamIds,
        provider: "anthropic",
        conversationId: id,
      });

      if (resolvedKey?.secretId) {
        const secret = await secretManager().getSecret(resolvedKey.secretId);
        // Support both old format (anthropicApiKey) and new format (apiKey)
        const secretValue =
          secret?.secret?.apiKey ?? secret?.secret?.anthropicApiKey;
        if (secretValue) {
          anthropicApiKey = secretValue as string;
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

  // Message Update Route
  fastify.patch(
    "/api/chat/messages/:id",
    {
      schema: {
        operationId: RouteId.UpdateChatMessage,
        description: "Update a specific text part in a message",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: z.object({
          partIndex: z.number().int().min(0),
          text: z.string().min(1),
          deleteSubsequentMessages: z.boolean().optional(),
        }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async (
      {
        params: { id },
        body: { partIndex, text, deleteSubsequentMessages },
        user,
        organizationId,
      },
      reply,
    ) => {
      // Fetch the message to get its conversation ID
      const message = await MessageModel.findById(id);

      if (!message) {
        throw new ApiError(404, "Message not found");
      }

      // Verify the user has access to the conversation
      const conversation = await ConversationModel.findById({
        id: message.conversationId,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Message not found or access denied");
      }

      // Update the message and optionally delete subsequent messages atomically
      // Using a transaction ensures both operations succeed or fail together,
      // preventing inconsistent state where message is updated but subsequent
      // messages remain when they should have been deleted
      await MessageModel.updateTextPartAndDeleteSubsequent(
        id,
        partIndex,
        text,
        deleteSubsequentMessages ?? false,
      );

      // Return updated conversation with all messages
      const updatedConversation = await ConversationModel.findById({
        id: message.conversationId,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!updatedConversation) {
        throw new ApiError(500, "Failed to retrieve updated conversation");
      }

      return reply.send(updatedConversation);
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
      const conversation = await ConversationModel.findById({
        id: id,
        userId: user.id,
        organizationId: organizationId,
      });

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
      const conversation = await ConversationModel.findById({
        id: id,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      await ConversationEnabledToolModel.setEnabledTools(id, toolIds);

      return reply.send({
        hasCustomSelection: true, // Always true when explicitly setting tools
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
      const conversation = await ConversationModel.findById({
        id: id,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      await ConversationEnabledToolModel.clearCustomSelection(id);

      return reply.send({ success: true });
    },
  );
};

/**
 * Validates that a chat API key exists, belongs to the organization,
 * and the user has access to it based on scope.
 * Throws ApiError if validation fails.
 */
async function validateChatApiKeyAccess(
  chatApiKeyId: string,
  userId: string,
  organizationId: string,
): Promise<void> {
  const apiKey = await ChatApiKeyModel.findById(chatApiKeyId);
  if (!apiKey || apiKey.organizationId !== organizationId) {
    throw new ApiError(404, "Chat API key not found");
  }

  // Verify user has access to the API key based on scope
  const userTeamIds = await TeamModel.getUserTeamIds(userId);
  const canAccessKey =
    apiKey.scope === "org_wide" ||
    (apiKey.scope === "personal" && apiKey.userId === userId) ||
    (apiKey.scope === "team" &&
      apiKey.teamId &&
      userTeamIds.includes(apiKey.teamId));

  if (!canAccessKey) {
    throw new ApiError(403, "You do not have access to this API key");
  }
}

export default chatRoutes;
