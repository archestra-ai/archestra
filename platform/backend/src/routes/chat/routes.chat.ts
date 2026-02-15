import {
  type ChatErrorResponse,
  RouteId,
  SupportedProviders,
  TimeInMs,
  type TokenUsage,
} from "@shared";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { CacheKey, cacheManager } from "@/cache-manager";
import { getChatMcpTools } from "@/clients/chat-mcp-client";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import {
  createDirectLLMModel,
  createLLMModelForAgent,
  detectProviderFromModel,
  FAST_MODELS,
  isApiKeyRequired,
  resolveProviderApiKey,
} from "@/clients/llm-client";
import config from "@/config";
import { browserStreamFeature } from "@/features/browser-stream/services/browser-stream.feature";
import { extractAndIngestDocuments } from "@/knowledge-graph/chat-document-extractor";
import logger from "@/logging";
import {
  AgentModel,
  ChatApiKeyModel,
  ConversationEnabledToolModel,
  ConversationModel,
  MessageModel,
  TeamModel,
} from "@/models";
import { getExternalAgentId } from "@/routes/proxy/utils/external-agent-id";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ErrorResponsesSchema,
  InsertConversationSchema,
  isSupportedChatProvider,
  SelectConversationSchema,
  type SupportedChatProvider,
  UpdateConversationSchema,
  UuidIdSchema,
} from "@/types";
import { estimateMessagesSize } from "@/utils/message-size";
import { mapProviderError, ProviderError } from "./errors";
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
          case "cohere":
            return { model: "command-r-08-2024", provider: "cohere" };
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
  if (config.chat.cohere?.apiKey) {
    return { model: "command-r-08-2024", provider: "cohere" };
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
      bodyLimit: config.api.bodyLimit,
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
    async (request, reply) => {
      const {
        body: { id: conversationId, messages },
        user,
        organizationId,
        headers,
      } = request;
      const chatAbortController = new AbortController();

      // Handle broken pipe gracefully when the client navigates away
      // The stream continues running but writing to a closed response should not crash
      reply.raw.on("error", (err: NodeJS.ErrnoException) => {
        if (
          err.code === "ERR_STREAM_WRITE_AFTER_END" ||
          err.message?.includes("write after end")
        ) {
          logger.debug(
            { conversationId },
            "Chat response stream closed by client",
          );
        } else {
          logger.error({ err, conversationId }, "Chat response stream error");
        }
      });

      // When the HTTP connection closes (stop button or navigate away), check if
      // a stop was explicitly requested via the distributed cache. This works across
      // pods because the cache is PostgreSQL-backed: the stop endpoint sets the flag
      // (possibly on a different pod), then the frontend's stop() closes the stream
      // connection which fires on THIS pod where the stream is running.
      const removeAbortListeners = attachRequestAbortListeners({
        request,
        reply,
        abortController: chatAbortController,
        conversationId,
      });

      // Extract and ingest documents to knowledge graph (fire and forget)
      // This runs asynchronously to avoid blocking the chat response
      extractAndIngestDocuments(messages).catch((error) => {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "[Chat] Background document ingestion failed",
        );
      });

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

      // Use agent ID as external agent ID if available, otherwise use header value
      // This allows agent names to be displayed in LLM proxy logs
      const headerExternalAgentId = getExternalAgentId(headers);
      const externalAgentId = conversation.agentId ?? headerExternalAgentId;

      // Fetch enabled tool IDs and custom selection status in parallel
      const [enabledToolIds, hasCustomSelection] = await Promise.all([
        ConversationEnabledToolModel.findByConversation(conversationId),
        ConversationEnabledToolModel.hasCustomSelection(conversationId),
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
        organizationId,
        // Pass conversationId as sessionId to group all chat requests (including delegated agents) together
        sessionId: conversation.id,
        // Pass agentId as initial delegation chain (will be extended by delegated agents)
        delegationChain: conversation.agentId,
        abortSignal: chatAbortController.signal,
      });

      // Build system prompt from agent's systemPrompt and userPrompt fields
      let systemPrompt: string | undefined;
      const systemPromptParts: string[] = [];
      const userPromptParts: string[] = [];

      // Collect system and user prompts from the agent
      if (conversation.agent.systemPrompt) {
        systemPromptParts.push(conversation.agent.systemPrompt);
      }
      if (conversation.agent.userPrompt) {
        userPromptParts.push(conversation.agent.userPrompt);
      }

      // Combine all prompts into system prompt (system prompts first, then user prompts)
      if (systemPromptParts.length > 0 || userPromptParts.length > 0) {
        const allParts = [...systemPromptParts, ...userPromptParts];
        systemPrompt = allParts.join("\n\n");
      }

      // Use stored provider if available, otherwise detect from model name for backward compatibility
      // At the moment of migration, all supported providers (anthropic, openai, gemini) serve different models,
      // so we can safely use detectProviderFromModel for them.
      const provider = isSupportedChatProvider(conversation.selectedProvider)
        ? conversation.selectedProvider
        : detectProviderFromModel(conversation.selectedModel);

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
          hasSystemPromptParts: systemPromptParts.length > 0,
          hasUserPromptParts: userPromptParts.length > 0,
          systemPromptProvided: !!systemPrompt,
          externalAgentId,
        },
        "Starting chat stream",
      );

      // Create LLM model using shared service
      // Pass conversationId as sessionId to group all requests in this chat session
      // Pass agent's llmApiKeyId so it can be used without user access check
      const { model } = await createLLMModelForAgent({
        organizationId,
        userId: user.id,
        agentId: conversation.agentId,
        model: conversation.selectedModel,
        provider,
        conversationId,
        externalAgentId,
        sessionId: conversationId,
        agentLlmApiKeyId: conversation.agent.llmApiKeyId,
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
        stopWhen: stepCountIs(500),
        abortSignal: chatAbortController.signal,
        onFinish: async ({ usage, finishReason }) => {
          removeAbortListeners();
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

      // For Gemini image generation models, enable image output via responseModalities
      // Known image-capable model patterns:
      // - gemini-2.0-flash-exp-image-generation
      // - gemini-2.5-flash-preview-native-audio-dialog (supports image output)
      // - Any model with "image-generation" in the name
      const modelLower = conversation.selectedModel.toLowerCase();
      const isGeminiImageModel =
        provider === "gemini" &&
        (modelLower.includes("image-generation") ||
          modelLower.includes("native-audio-dialog") ||
          modelLower === "gemini-2.5-flash-image");
      if (isGeminiImageModel) {
        streamTextConfig.providerOptions = {
          google: {
            responseModalities: ["TEXT", "IMAGE"],
          },
        };
      }

      // Create stream with token usage data support
      const response = createUIMessageStreamResponse({
        headers: {
          // Prevent compression middleware from buffering the stream
          // See: https://ai-sdk.dev/docs/troubleshooting/streaming-not-working-when-proxied
          "Content-Encoding": "none",
        },
        stream: createUIMessageStream({
          execute: async ({ writer }) => {
            const result = streamText(streamTextConfig);

            // Merge the stream text result into the UI message stream
            writer.merge(
              result.toUIMessageStream({
                originalMessages: messages as UIMessage[],
                onError: (error) => {
                  logger.error(
                    { error, conversationId, agentId: conversation.agentId },
                    "Chat stream error occurred",
                  );

                  // Use pre-built error from subagent if available (preserves correct provider),
                  // otherwise map the error with the current provider
                  const mappedError: ChatErrorResponse =
                    error instanceof ProviderError
                      ? error.chatErrorResponse
                      : mapProviderError(error, provider);

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
                  removeAbortListeners();
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
              }),
            );

            // Wait for the stream to complete and get usage data
            const usage = await result.usage;

            // Write token usage data to the stream as a custom data part
            if (usage) {
              logger.info(
                {
                  conversationId,
                  usage,
                },
                "Chat stream finished with usage data",
              );

              // Send usage data as a custom data part
              // The type must be 'data-<name>' format for the AI SDK to recognize it
              writer.write({
                type: "data-token-usage",
                data: {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  totalTokens: usage.totalTokens,
                } satisfies TokenUsage,
              });
            }
          },
        }),
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

  fastify.post(
    "/api/chat/conversations/:id/stop",
    {
      schema: {
        operationId: RouteId.StopChatStream,
        description: "Stop a running chat stream for a conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(z.object({ stopped: z.boolean() })),
      },
    },
    async ({ params: { id } }, reply) => {
      // Set stop flag in distributed cache so any pod can detect it on connection close.
      // When the frontend subsequently calls stop() to close the streaming connection,
      // the connection-close handler on the pod running the stream will find this flag
      // and abort the stream.
      const cacheKey = `${CacheKey.ChatStop}-${id}` as const;
      await cacheManager.set(cacheKey, true, TimeInMs.Minute);
      return reply.send({ stopped: true });
    },
  );

  fastify.get(
    "/api/chat/conversations",
    {
      schema: {
        operationId: RouteId.GetChatConversations,
        description:
          "List all conversations for current user with agent details. Optionally filter by search query.",
        tags: ["Chat"],
        querystring: z.object({
          search: z.string().optional(),
        }),
        response: constructResponseSchema(z.array(SelectConversationSchema)),
      },
    },
    async (request, reply) => {
      const { search } = request.query;
      return reply.send(
        await ConversationModel.findAll(
          request.user.id,
          request.organizationId,
          search,
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
    async ({ params: { agentId }, user, organizationId, headers }, reply) => {
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
        organizationId,
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
          title: true,
          selectedModel: true,
          selectedProvider: true,
          chatApiKeyId: true,
        })
          .required({ agentId: true })
          .partial({
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
        body: { agentId, title, selectedModel, selectedProvider, chatApiKeyId },
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
      // Skip validation if it matches the agent's configured key (permission flows through agent access)
      if (chatApiKeyId && chatApiKeyId !== agent.llmApiKeyId) {
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

      // Create conversation with agent
      return reply.send(
        await ConversationModel.create({
          userId: user.id,
          organizationId,
          agentId,
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
      // Skip validation if it matches the agent's configured key (permission flows through agent access)
      if (body.chatApiKeyId) {
        const currentConversation = await ConversationModel.findById({
          id,
          userId: user.id,
          organizationId,
        });

        if (
          !currentConversation ||
          body.chatApiKeyId !== currentConversation.agent.llmApiKeyId
        ) {
          await validateChatApiKeyAccess(
            body.chatApiKeyId,
            user.id,
            organizationId,
          );
        }
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
            organizationId,
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

      // Extract first user and assistant messages
      const { firstUserMessage, firstAssistantMessage } = extractFirstMessages(
        conversation.messages || [],
      );

      // Need at least user message to generate title
      if (!firstUserMessage) {
        logger.info(
          { conversationId: id },
          "Skipping title generation - no user message found",
        );
        return reply.send(conversation);
      }

      // Use the conversation's selected provider for title generation
      // This ensures the title is generated using the same provider as the chat
      // Fall back to detecting from model name for backward compatibility
      const provider = isSupportedChatProvider(conversation.selectedProvider)
        ? conversation.selectedProvider
        : detectProviderFromModel(conversation.selectedModel);

      // Resolve API key using the centralized function (handles all providers)
      const { apiKey } = await resolveProviderApiKey({
        organizationId,
        userId: user.id,
        provider,
        conversationId: id,
      });

      if (isApiKeyRequired(provider, apiKey)) {
        throw new ApiError(
          400,
          "LLM Provider API key not configured. Please configure it in Chat Settings.",
        );
      }

      // Generate title using the extracted function
      const generatedTitle = await generateConversationTitle({
        provider,
        apiKey,
        firstUserMessage,
        firstAssistantMessage,
      });

      if (!generatedTitle) {
        // Return the conversation without title update on error
        return reply.send(conversation);
      }

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

// ============================================================================
// Title Generation Functions (extracted for testability)
// ============================================================================

/**
 * Message structure from AI SDK UIMessage
 */
interface MessagePart {
  type: string;
  text?: string;
}

interface Message {
  role: string;
  parts?: MessagePart[];
}

/**
 * Result of extracting first messages from a conversation
 */
export interface ExtractedMessages {
  firstUserMessage: string;
  firstAssistantMessage: string;
}

/**
 * Extracts the first user message and first assistant message text from conversation messages.
 * Used for generating conversation titles.
 */
export function extractFirstMessages(messages: unknown[]): ExtractedMessages {
  let firstUserMessage = "";
  let firstAssistantMessage = "";

  for (const msg of messages) {
    const msgContent = msg as Message;
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

  return { firstUserMessage, firstAssistantMessage };
}

/**
 * Builds the prompt for title generation based on extracted messages.
 */
export function buildTitlePrompt(
  firstUserMessage: string,
  firstAssistantMessage: string,
): string {
  const contextMessages = firstAssistantMessage
    ? `User: ${firstUserMessage}\n\nAssistant: ${firstAssistantMessage}`
    : `User: ${firstUserMessage}`;

  return `Generate a short, concise title (3-6 words) for a chat conversation that includes the following messages:

${contextMessages}

The title should capture the main topic or theme of the conversation. Respond with ONLY the title, no quotes, no explanation. DON'T WRAP THE TITLE IN QUOTES!!!`;
}

/**
 * Parameters for generating a conversation title
 */
export interface GenerateTitleParams {
  provider: SupportedChatProvider;
  apiKey: string | undefined;
  firstUserMessage: string;
  firstAssistantMessage: string;
}

/**
 * Generates a conversation title using the specified provider.
 * Returns the generated title or null if generation fails.
 */
export async function generateConversationTitle(
  params: GenerateTitleParams,
): Promise<string | null> {
  const { provider, apiKey, firstUserMessage, firstAssistantMessage } = params;

  // Create model for title generation (direct call, not through LLM Proxy)
  const model = createDirectLLMModel({
    provider,
    apiKey,
    modelName: FAST_MODELS[provider],
  });

  const titlePrompt = buildTitlePrompt(firstUserMessage, firstAssistantMessage);

  try {
    const result = await generateText({
      model,
      prompt: titlePrompt,
    });

    return result.text.trim();
  } catch (error) {
    logger.error({ error, provider }, "Failed to generate conversation title");
    return null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Listens for HTTP connection close and checks the distributed cache to determine
 * whether the close was caused by the stop button (abort) or by navigating away (ignore).
 *
 * Flow:
 * 1. Frontend stop button → calls POST /stop (sets cache flag) → then calls stop() (closes connection)
 * 2. Connection close fires on the pod running the stream → checks cache → flag found → abort
 * 3. Navigate away → connection close → checks cache → no flag → stream continues in background
 *
 * Works across pods because the cache is PostgreSQL-backed.
 */
function attachRequestAbortListeners(params: {
  request: { raw: NodeJS.EventEmitter };
  reply: { raw: NodeJS.EventEmitter & { writableEnded: boolean } };
  abortController: AbortController;
  conversationId: string;
}): () => void {
  const { request, reply, abortController, conversationId } = params;
  let didCleanup = false;

  const onConnectionClose = () => {
    cleanup();
    if (reply.raw.writableEnded || abortController.signal.aborted) {
      return;
    }

    // Check the distributed cache for a stop flag set by the stop endpoint
    const cacheKey = `${CacheKey.ChatStop}-${conversationId}` as const;
    cacheManager
      .getAndDelete(cacheKey)
      .then((stopRequested) => {
        if (stopRequested) {
          logger.info(
            { conversationId },
            "Chat stop requested, aborting stream execution",
          );
          abortController.abort();
        } else {
          logger.info(
            { conversationId },
            "Chat connection closed (navigate away), stream continues in background",
          );
        }
      })
      .catch((err) => {
        logger.error(
          { err, conversationId },
          "Failed to check chat stop flag, not aborting",
        );
      });
  };

  const cleanup = () => {
    if (didCleanup) {
      return;
    }

    didCleanup = true;
    request.raw.removeListener("close", onConnectionClose);
    request.raw.removeListener("aborted", onConnectionClose);
    reply.raw.removeListener("close", onConnectionClose);
  };

  request.raw.on("close", onConnectionClose);
  request.raw.on("aborted", onConnectionClose);
  reply.raw.on("close", onConnectionClose);

  return cleanup;
}

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
