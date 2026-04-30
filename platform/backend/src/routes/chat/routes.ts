import {
  buildUserSystemPromptContext,
  type ChatErrorResponse,
  isSupportedProvider,
  RouteId,
  type SupportedProvider,
  TimeInMs,
  type TokenUsage,
} from "@shared";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  hasToolCall,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import { CacheKey, cacheManager } from "@/cache-manager";
import {
  fetchToolUiResource,
  getChatMcpTools,
  getChatMcpToolUiResourceUris,
  type ToolUiResourceData,
} from "@/clients/chat-mcp-client";
import {
  createDirectLLMModel,
  createLLMModelForAgent,
  detectProviderFromModel,
  isApiKeyRequired,
} from "@/clients/llm-client";
import config from "@/config";
import { browserStreamFeature } from "@/features/browser-stream/services/browser-stream.feature";
import { extractAndIngestDocuments } from "@/knowledge-base";
import logger from "@/logging";
import {
  AgentModel,
  ConversationChatErrorModel,
  ConversationEnabledToolModel,
  ConversationModel,
  ConversationShareModel,
  LlmProviderApiKeyModel,
  MemberModel,
  MessageModel,
  OrganizationModel,
  TeamModel,
} from "@/models";
import { startActiveChatSpan } from "@/observability/tracing";
import {
  promptNeedsRendering,
  renderSystemPrompt,
  type UserSystemPromptContext,
} from "@/templating";
import {
  ApiError,
  type ChatMessage,
  type ChatMessagePart,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ErrorResponsesSchema,
  InsertConversationSchema,
  SelectConversationSchema,
  SelectConversationShareWithTargetsSchema,
  type UpdateConversation,
  UpdateConversationSchema,
  UuidIdSchema,
} from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import {
  resolveConversationLlmSelectionForAgent,
  resolveFastModelName,
  resolveSmartDefaultLlmForChat,
} from "@/utils/llm-resolution";
import { estimateMessagesSize } from "@/utils/message-size";
import {
  parseMaxInputTokens,
  shouldProbeTextStreamForContextTrimRetry,
  trimMessagesToTokenLimit,
} from "./context-trimming";
import {
  getActiveTraceContext,
  mapProviderError,
  ProviderError,
  sanitizeChatErrorForFrontend,
} from "./errors";
import { normalizeChatMessages } from "./normalization/normalize-chat-messages";

function getCorrelationLogFields(traceContext: {
  sessionId?: string;
  traceId?: string;
  spanId?: string;
}) {
  return {
    ...(traceContext.sessionId ? { session_id: traceContext.sessionId } : {}),
    ...(traceContext.traceId ? { trace_id: traceContext.traceId } : {}),
    ...(traceContext.spanId ? { span_id: traceContext.spanId } : {}),
  };
}

function getMinimalFrontendError(errorForFrontend: ChatErrorResponse) {
  return {
    code: errorForFrontend.code,
    message: errorForFrontend.message,
    isRetryable: errorForFrontend.isRetryable,
    ...(errorForFrontend.sessionId
      ? { sessionId: errorForFrontend.sessionId }
      : {}),
    ...(errorForFrontend.traceId ? { traceId: errorForFrontend.traceId } : {}),
    ...(errorForFrontend.spanId ? { spanId: errorForFrontend.spanId } : {}),
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
      } = request;
      const chatAbortController = new AbortController();

      // Flag to prevent duplicate message persistence if both onError and onFinish fire
      let messagesPersisted = false;

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

      // Get conversation
      const conversation = await ConversationModel.findById({
        id: conversationId,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      // Check if the agent was deleted
      if (!conversation.agentId || !conversation.agent) {
        throw new ApiError(
          400,
          "The agent associated with this conversation has been deleted",
        );
      }

      const { agentId, agent } = conversation;

      // Extract and ingest documents to agent's knowledge base (fire and forget)
      // This runs asynchronously to avoid blocking the chat response
      extractAndIngestDocuments(messages, agentId).catch((error) => {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "[Chat] Background document ingestion failed",
        );
      });

      const externalAgentId = agentId;

      // Fetch enabled tool IDs and custom selection status in parallel
      const [enabledToolIds, hasCustomSelection, slimChatErrorUi] =
        await Promise.all([
          ConversationEnabledToolModel.findByConversation(conversationId),
          ConversationEnabledToolModel.hasCustomSelection(conversationId),
          OrganizationModel.getSlimChatErrorUi(organizationId),
        ]);

      // Fetch MCP tools with enabled tool filtering
      // Pass undefined if no custom selection (use all tools)
      // Pass the actual array (even if empty) if there is custom selection
      const [mcpTools, toolUiResourceUris] = await Promise.all([
        getChatMcpTools({
          agentName: agent.name,
          agentId,
          userId: user.id,
          enabledToolIds: hasCustomSelection ? enabledToolIds : undefined,
          conversationId: conversation.id,
          organizationId,
          // Pass conversationId as sessionId to group all chat requests (including delegated agents) together
          sessionId: conversation.id,
          // Pass agentId as initial delegation chain (will be extended by delegated agents)
          delegationChain: agentId,
          abortSignal: chatAbortController.signal,
          user: { id: user.id, email: user.email, name: user.name },
        }),
        getChatMcpToolUiResourceUris(conversation.agentId),
      ]);

      // Build system prompt from agent's systemPrompt field
      let systemPrompt: string | undefined;

      // Build template context only when prompts use Handlebars syntax
      let promptContext: UserSystemPromptContext | null = null;
      if (promptNeedsRendering(agent.systemPrompt)) {
        const userTeams = await TeamModel.getUserTeams(user.id);
        promptContext = buildUserSystemPromptContext({
          userName: user.name,
          userEmail: user.email,
          userTeams: userTeams.map((t) => t.name),
        });
      }

      const renderedPrompt = renderSystemPrompt(
        agent.systemPrompt,
        promptContext,
      );

      let toolResultInstructions: string = "";
      // Add MCP UI instruction when tools are available
      if (Object.keys(mcpTools).length > 0) {
        toolResultInstructions =
          "When a tool result includes a UI resource, it means an interactive UI was rendered for the user. Respond with at most one brief sentence. Never describe, list, or explain what the UI shows.";
      }

      const toolDenialInstruction =
        "When a tool execution is not approved by the user, do not retry it. Explain what happened and ask the user what they'd like to do instead.";

      systemPrompt =
        [renderedPrompt, toolDenialInstruction, toolResultInstructions]
          .filter(Boolean)
          .join("\n\n") || undefined;

      // Use stored provider if available, otherwise detect from model name for backward compatibility
      // At the moment of migration, all supported providers (anthropic, openai, gemini) serve different models,
      // so we can safely use detectProviderFromModel for them.
      const provider = isSupportedProvider(conversation.selectedProvider)
        ? conversation.selectedProvider
        : detectProviderFromModel(conversation.selectedModel);

      logger.info(
        {
          conversationId,
          agentId,
          userId: user.id,
          orgId: organizationId,
          toolCount: Object.keys(mcpTools).length,
          hasCustomToolSelection: hasCustomSelection,
          enabledToolCount: hasCustomSelection ? enabledToolIds.length : "all",
          model: conversation.selectedModel,
          provider,
          providerSource: conversation.selectedProvider ? "stored" : "detected",
          hasSystemPrompt: !!systemPrompt,
          externalAgentId,
        },
        "Starting chat stream",
      );

      // Wrap the entire chat turn in a parent span so LLM calls (via proxy)
      // and MCP tool executions appear as children of a single trace.
      return startActiveChatSpan({
        agentName: agent.name,
        agentId,
        sessionId: conversationId,
        user: { id: user.id, email: user.email, name: user.name },
        callback: async () => {
          // Create LLM model using shared service
          // Pass conversationId as sessionId to group all requests in this chat session
          // Pass agent's llmApiKeyId so it can be used without user access check
          const { model } = await createLLMModelForAgent({
            organizationId,
            userId: user.id,
            agentId,
            model: conversation.selectedModel,
            provider,
            conversationId,
            externalAgentId,
            sessionId: conversationId,
            source: "chat",
            agentLlmApiKeyId: agent.llmApiKeyId,
          });

          // Normalize chat history before replaying it to the model.
          // This dedupes repeated tool parts, drops dangling interrupted tool calls,
          // and strips heavy image/browser payloads that would otherwise bloat context.
          const normalizedMessagesForLLM = normalizeChatMessages(
            messages as ChatMessage[],
          );
          const providerPreparedMessages = prepareMessagesForProvider({
            messages: normalizedMessagesForLLM,
            provider,
          });

          // Stream with AI SDK
          // Build streamText config conditionally
          // Cast to UIMessage[] - ChatMessage is structurally compatible at runtime
          const modelMessages = await convertToModelMessages(
            providerPreparedMessages as unknown as Omit<UIMessage, "id">[],
          );

          // Perplexity does NOT support tool calling - it has built-in web search instead
          // @see https://docs.perplexity.ai/api-reference/chat-completions-post
          const supportsToolCalling = provider !== "perplexity";

          const streamTextConfig: Parameters<typeof streamText>[0] = {
            model,
            messages: modelMessages,
            ...(supportsToolCalling && { tools: mcpTools }),
            stopWhen: buildChatStopConditions(),
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
          // - gemini-2.5-flash-image
          // - gemini-3-pro-image-preview (and similar Gemini 3 image models)
          // - Any model with "image" in the name (covers current and future image models)
          //
          // TODO: Use output modalities from the models DB table instead of hardcoded
          // pattern matching. The `models` table has capability info that would be more
          // reliable, but some models (e.g. gemini-3-pro-image-preview) currently report
          // "capabilities unknown", so that needs to be fixed first.
          const modelLower = conversation.selectedModel.toLowerCase();
          const isGeminiImageModel =
            provider === "gemini" &&
            (modelLower.includes("image") ||
              modelLower.includes("native-audio-dialog"));
          if (isGeminiImageModel) {
            streamTextConfig.providerOptions = {
              google: {
                responseModalities: ["TEXT", "IMAGE"],
              },
            };
          }

          // Persist user's new messages immediately so they're visible on page reload.
          // Without this, a reload during streaming shows no messages because
          // onFinish hasn't fired yet. persistNewMessages is idempotent — it only
          // saves messages beyond the existing count, so onFinish will only save
          // the assistant response.
          try {
            await persistNewMessages(conversationId, messages, "earlyUserMsg");
          } catch (error) {
            logger.warn(
              { error, conversationId },
              "Failed to persist user messages early (will retry in onFinish)",
            );
          }

          // Create stream with token usage data support
          const response = createUIMessageStreamResponse({
            headers: {
              // Prevent compression middleware from buffering the stream
              // See: https://ai-sdk.dev/docs/troubleshooting/streaming-not-working-when-proxied
              "Content-Encoding": "none",
            },
            stream: createUIMessageStream({
              // Preserve incoming message IDs so the client updates existing
              // assistant messages instead of rendering duplicate ones.
              originalMessages: messages as UIMessage[],
              onError: (error) => {
                // Persist messages on stream-level errors (e.g. errors thrown
                // in execute before writer.merge() is reached). Without this,
                // user messages are lost on refresh after an error.
                const shouldPersist = !messagesPersisted && !!conversationId;
                if (shouldPersist) {
                  messagesPersisted = true;
                }
                (async () => {
                  if (shouldPersist) {
                    try {
                      await persistNewMessages(
                        conversationId,
                        messages,
                        "onStreamError",
                      );
                    } catch (persistError) {
                      logger.error(
                        { persistError, conversationId },
                        "Failed to persist messages during stream error",
                      );
                    }
                  }
                })().catch((err) => {
                  logger.error(
                    { err },
                    "Unexpected error in onError async persist handler",
                  );
                });

                const mapped = mapProviderError(error, provider);
                const traceContext = getActiveTraceContext();
                const correlationLogFields =
                  getCorrelationLogFields(traceContext);
                const fullError = { ...mapped, ...traceContext };
                const errorForFrontend = slimChatErrorUi
                  ? sanitizeChatErrorForFrontend(fullError)
                  : fullError;
                persistConversationChatError({
                  conversationId,
                  error: errorForFrontend,
                });

                logger.info(
                  {
                    mappedError: fullError,
                    originalErrorType:
                      error instanceof Error ? error.name : typeof error,
                    willBeSentToFrontend: true,
                    ...correlationLogFields,
                  },
                  "Returning mapped error to frontend before stream starts",
                );
                try {
                  return JSON.stringify(errorForFrontend);
                } catch {
                  logger.error(
                    {
                      errorCode: mapped.code,
                      ...correlationLogFields,
                    },
                    "Failed to stringify mapped pre-stream error, returning minimal error",
                  );
                  return JSON.stringify(
                    getMinimalFrontendError(errorForFrontend),
                  );
                }
              },
              execute: async ({ writer }) => {
                // Send heartbeat every 5s to prevent connection drops
                // during long-running tool executions / subagent calls.
                const heartbeatInterval = setInterval(() => {
                  try {
                    writer.write({
                      type: "data-heartbeat",
                      data: { timestamp: Date.now() },
                    });
                  } catch {
                    clearInterval(heartbeatInterval);
                  }
                }, 5000);

                // Prefetch all UI resources eagerly before streaming starts
                // so onChunk can write data-tool-ui-start synchronously.
                // Even with LRU caching, .then() on a resolved promise runs
                // as a microtask — the stream processes more chunks before
                // the microtask fires, causing data-tool-ui-start to arrive
                // after all tool deltas instead of right after tool-input-start.
                const MAX_SSE_HTML_BYTES = 1024 * 1024;
                const prefetchedUiResources = new Map<
                  string,
                  ToolUiResourceData
                >();
                const agentIdForUi = conversation.agentId;
                if (
                  agentIdForUi &&
                  Object.keys(toolUiResourceUris).length > 0
                ) {
                  await Promise.all(
                    Object.entries(toolUiResourceUris).map(
                      async ([toolName, uri]) => {
                        try {
                          const resource = await fetchToolUiResource({
                            agentId: agentIdForUi,
                            userId: user.id,
                            organizationId,
                            conversationId: conversation.id,
                            toolName,
                            uri,
                          });
                          if (resource) {
                            const html =
                              resource.html &&
                              Buffer.byteLength(resource.html) <=
                                MAX_SSE_HTML_BYTES
                                ? resource.html
                                : undefined;
                            if (html)
                              prefetchedUiResources.set(toolName, {
                                ...resource,
                                html,
                              });
                          }
                        } catch (err) {
                          logger.debug(
                            { err, toolName },
                            "Failed to prefetch UI resource",
                          );
                        }
                      },
                    ),
                  );
                }

                // Emit data-tool-ui-start synchronously in onChunk so it
                // arrives right after tool-input-start, before any deltas.
                streamTextConfig.onChunk = ({ chunk }) => {
                  if (chunk.type === "tool-input-start" && chunk.toolName) {
                    const prefetched = prefetchedUiResources.get(
                      chunk.toolName,
                    );
                    if (prefetched) {
                      writer.write({
                        type: "data-tool-ui-start",
                        data: {
                          toolCallId: chunk.id,
                          toolName: chunk.toolName,
                          uiResourceUri: toolUiResourceUris[chunk.toolName],
                          html: prefetched.html,
                          csp: prefetched.csp,
                          permissions: prefetched.permissions,
                        },
                      });
                    }
                  }
                };

                // ⚠️ TEMPORARY: Error injection for testing retries. Remove after testing.
                const lastMsg = (
                  messages as { parts?: { type: string; text?: string }[] }[]
                ).at(-1);
                const lastText =
                  lastMsg?.parts?.find((p) => p.type === "text")?.text ?? "";
                if (lastText.includes("__test_500")) {
                  throw new Error("Simulated server error (500)");
                }
                if (lastText.includes("__test_network")) {
                  throw new TypeError("Failed to fetch");
                }
                if (lastText.includes("__test_no_output")) {
                  throw new Error(
                    "No output generated. Check the stream for errors.",
                  );
                }

                // Stream tokens to the client in real-time while also
                // handling context-length errors from vLLM/LiteLLM.
                //
                // Context-length errors (400) are rejected by the provider
                // before any tokens are emitted. We detect this by reading
                // the first chunk from textStream — if the provider rejects,
                // the iterator throws immediately. We then parse the error,
                // trim messages, and retry with a new streamText call.
                //
                // For successful requests, the first chunk arrives quickly
                // and we proceed to merge the full stream to the client.
                let result = streamText(streamTextConfig);

                // Try reading the first text chunk to detect immediate provider errors.
                // Context-length errors fire before any tokens, so this catches them
                // without blocking normal streaming (first token arrives in ~100-500ms).
                if (shouldProbeTextStreamForContextTrimRetry(provider)) {
                  try {
                    const reader = result.textStream[Symbol.asyncIterator]();
                    await reader.next();
                  } catch (error) {
                    const maxTokens = parseMaxInputTokens(error);
                    if (maxTokens !== null) {
                      const trimmed = trimMessagesToTokenLimit(
                        modelMessages,
                        maxTokens,
                      );
                      logger.info(
                        {
                          maxTokens,
                          originalMessages: modelMessages.length,
                          trimmedMessages: trimmed.length,
                          conversationId,
                        },
                        "[ContextTrimming] retrying with trimmed messages",
                      );
                      result = streamText({
                        ...streamTextConfig,
                        messages: trimmed,
                      });
                    } else {
                      // Save messages before throwing — this error path runs before
                      // writer.merge(), so onError/onFinish callbacks won't fire.
                      if (!messagesPersisted && conversationId) {
                        messagesPersisted = true;
                        try {
                          await persistNewMessages(
                            conversationId,
                            messages,
                            "onExecuteError",
                          );
                        } catch (persistError) {
                          logger.error(
                            { persistError, conversationId },
                            "Failed to persist messages during execute error",
                          );
                        }
                      }
                      throw error;
                    }
                  }
                }

                // toUIMessageStream invokes onError twice for the same upstream
                // error (once when formatting the error chunk's errorText, once
                // as a notification when the chunk is walked downstream). Guard
                // so we don't persist or log the same error twice.
                let chatErrorHandled = false;
                let serializedChatError = "";

                writer.merge(
                  result.toUIMessageStream({
                    originalMessages: messages as UIMessage[],
                    onError: (error) => {
                      if (chatErrorHandled) {
                        return serializedChatError;
                      }
                      chatErrorHandled = true;

                      const traceContext = getActiveTraceContext();
                      const correlationLogFields =
                        getCorrelationLogFields(traceContext);

                      // Use pre-built error from subagent if available (preserves correct provider),
                      // otherwise map the error with the current provider
                      const mappedError: ChatErrorResponse =
                        error instanceof ProviderError
                          ? error.chatErrorResponse
                          : mapProviderError(error, provider);
                      const fullError = { ...mappedError, ...traceContext };
                      const errorForFrontend = slimChatErrorUi
                        ? sanitizeChatErrorForFrontend(fullError)
                        : fullError;

                      // mapProviderError safely serializes raw errors, but add defensive try-catch
                      try {
                        serializedChatError = JSON.stringify(errorForFrontend);
                      } catch (stringifyError) {
                        logger.error(
                          {
                            stringifyError,
                            errorCode: mappedError.code,
                            ...correlationLogFields,
                          },
                          "Failed to stringify mapped error, returning minimal error",
                        );
                        serializedChatError = JSON.stringify(
                          getMinimalFrontendError(errorForFrontend),
                        );
                      }

                      // Claim persistence before the async work below starts,
                      // otherwise onFinish can race and also persist (duplicates).
                      const shouldPersist =
                        !messagesPersisted && !!conversationId;
                      if (shouldPersist) {
                        messagesPersisted = true;
                      }

                      (async () => {
                        logger.error(
                          {
                            error,
                            conversationId,
                            agentId,
                            ...correlationLogFields,
                          },
                          "Chat stream error occurred",
                        );

                        // Persist messages despite error so they have a valid ID for editing
                        if (shouldPersist) {
                          try {
                            await persistNewMessages(
                              conversationId,
                              messages,
                              "onError",
                            );
                          } catch (persistError) {
                            // Log persistence error but don't prevent the error response
                            logger.error(
                              { persistError, conversationId },
                              "Failed to persist messages during error handling",
                            );
                          }
                        }
                      })().catch((err) => {
                        // Log any errors from the async IIFE but don't crash
                        logger.error(
                          { err },
                          "Unexpected error in onError async handler",
                        );
                      });

                      persistConversationChatError({
                        conversationId,
                        error: errorForFrontend,
                      });

                      logger.info(
                        {
                          mappedError: fullError,
                          originalErrorType:
                            error instanceof Error ? error.name : typeof error,
                          willBeSentToFrontend: true,
                          ...correlationLogFields,
                        },
                        "Returning mapped error to frontend via stream",
                      );

                      return serializedChatError;
                    },
                    onFinish: async ({ messages: finalMessages }) => {
                      removeAbortListeners();

                      // Only persist if not already persisted by onError
                      if (!messagesPersisted && conversationId) {
                        try {
                          await persistNewMessages(
                            conversationId,
                            finalMessages,
                            "onFinish",
                          );
                          messagesPersisted = true;
                        } catch (error) {
                          logger.error(
                            { error, conversationId },
                            "Failed to persist messages during onFinish",
                          );
                        }
                      }
                    },
                  }),
                );

                // Wait for the stream to complete and get usage data.
                // Catch NoOutputGeneratedError (thrown when provider errors
                // prevent any output) to avoid emitting a second, generic
                // error event that would race with the detailed provider error
                // already flowing through toUIMessageStream's onError.
                const usage = await Promise.resolve(result.usage).catch(
                  () => null,
                );

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

                clearInterval(heartbeatInterval);
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
      });
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
      const conversation = await ConversationModel.findAccessibleById({
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
    async ({ params: { agentId }, user, organizationId }, reply) => {
      // Check if user is an agent admin
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

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
      },
      reply,
    ) => {
      // Check if user is an agent admin
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

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
        const smartDefault = await resolveSmartDefaultLlmForChat({
          organizationId,
          userId: user.id,
        });
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
    async ({ params: { id }, body, user, organizationId }, reply) => {
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
          body.chatApiKeyId !== currentConversation.agent?.llmApiKeyId
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
        const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
          userId: user.id,
          organizationId,
        });

        const agent = await AgentModel.findById(
          body.agentId,
          user.id,
          isAgentAdmin,
        );
        if (!agent) {
          throw new ApiError(404, "Agent not found");
        }

        if (
          body.selectedModel === undefined &&
          body.selectedProvider === undefined &&
          body.chatApiKeyId === undefined
        ) {
          const llmSelection = await resolveConversationLlmSelectionForAgent({
            agent: {
              llmApiKeyId: agent.llmApiKeyId ?? null,
              llmModel: agent.llmModel ?? null,
            },
            organizationId,
            userId: user.id,
          });

          body.selectedModel = llmSelection.selectedModel;
          body.selectedProvider = llmSelection.selectedProvider;
          body.chatApiKeyId = llmSelection.chatApiKeyId;
        }
      }

      // Coerce pinnedAt ISO string to Date for database storage
      const pinnedAtDate =
        body.pinnedAt != null ? new Date(body.pinnedAt) : body.pinnedAt;
      const updateData: UpdateConversation = {
        ...body,
        pinnedAt: pinnedAtDate,
      };

      const conversation = await ConversationModel.update(
        id,
        user.id,
        organizationId,
        updateData,
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

      if (conversation?.agentId && browserStreamFeature.isEnabled()) {
        // Close browser tab for this conversation (best effort, don't fail if it errors)
        try {
          await browserStreamFeature.closeTab(conversation.agentId, id, {
            userId: user.id,
            organizationId,
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

  fastify.get(
    "/api/chat/conversations/:id/share",
    {
      schema: {
        operationId: RouteId.GetConversationShare,
        description: "Get share status for a conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(
          SelectConversationShareWithTargetsSchema.nullable(),
        ),
      },
    },
    async ({ params: { id }, user, organizationId }) => {
      const conversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      return ConversationShareModel.findByConversationId({
        conversationId: id,
        organizationId,
      });
    },
  );

  fastify.post(
    "/api/chat/conversations/:id/share",
    {
      schema: {
        operationId: RouteId.ShareConversation,
        description:
          "Share a conversation with your organization, specific teams, or specific users",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: z
          .object({
            visibility: z.enum(["organization", "team", "user"]),
            teamIds: z.array(z.string()).optional(),
            userIds: z.array(z.string()).optional(),
          })
          .superRefine((value, ctx) => {
            if (
              value.visibility === "team" &&
              (value.teamIds ?? []).length === 0
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Select at least one team",
                path: ["teamIds"],
              });
            }

            if (
              value.visibility === "user" &&
              (value.userIds ?? []).length === 0
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Select at least one user",
                path: ["userIds"],
              });
            }
          }),
        response: constructResponseSchema(
          SelectConversationShareWithTargetsSchema,
        ),
      },
    },
    async ({ params: { id }, body, user, organizationId }) => {
      const conversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      const teamIds = Array.from(new Set(body.teamIds ?? []));
      const userIds = Array.from(new Set(body.userIds ?? []));

      if (body.visibility === "team") {
        const teams = await TeamModel.findByIds(teamIds);
        const validTeamIds = new Set(
          teams
            .filter((team) => team.organizationId === organizationId)
            .map((team) => team.id),
        );

        if (validTeamIds.size !== teamIds.length) {
          throw new ApiError(400, "One or more selected teams are invalid");
        }
      }

      if (body.visibility === "user") {
        const validUserIds = new Set(
          await MemberModel.findUserIdsInOrganization({
            organizationId,
            userIds,
          }),
        );

        if (validUserIds.size !== userIds.length) {
          throw new ApiError(400, "One or more selected users are invalid");
        }
      }

      return ConversationShareModel.upsert({
        conversationId: id,
        organizationId,
        createdByUserId: user.id,
        visibility: body.visibility,
        teamIds: body.visibility === "team" ? teamIds : [],
        userIds: body.visibility === "user" ? userIds : [],
      });
    },
  );

  fastify.delete(
    "/api/chat/conversations/:id/share",
    {
      schema: {
        operationId: RouteId.UnshareConversation,
        description: "Revoke sharing of a conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id }, user, organizationId }) => {
      const deleted = await ConversationShareModel.delete({
        conversationId: id,
        organizationId,
        userId: user.id,
      });

      if (!deleted) {
        throw new ApiError(404, "Share not found");
      }

      return { success: true };
    },
  );

  fastify.get(
    "/api/chat/shared/:shareId",
    {
      schema: {
        operationId: RouteId.GetSharedConversation,
        description: "Get a shared conversation by share ID",
        tags: ["Chat"],
        params: z.object({ shareId: UuidIdSchema }),
        response: constructResponseSchema(
          SelectConversationSchema.extend({
            sharedByUserId: z.string(),
          }),
        ),
      },
    },
    async ({ params: { shareId }, organizationId, user }) => {
      const conversation = await ConversationShareModel.getSharedConversation({
        shareId,
        organizationId,
        userId: user.id,
      });

      if (!conversation) {
        throw new ApiError(404, "Shared conversation not found");
      }

      return conversation;
    },
  );

  fastify.post(
    "/api/chat/shared/:shareId/fork",
    {
      schema: {
        operationId: RouteId.ForkSharedConversation,
        description:
          "Create a new conversation from a shared conversation's messages",
        tags: ["Chat"],
        params: z.object({ shareId: UuidIdSchema }),
        body: z.object({
          agentId: z.string().uuid(),
        }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({
      params: { shareId },
      body: { agentId },
      user,
      organizationId,
    }) => {
      const sharedConversation =
        await ConversationShareModel.getSharedConversation({
          shareId,
          organizationId,
          userId: user.id,
        });

      if (!sharedConversation) {
        throw new ApiError(404, "Shared conversation not found");
      }

      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      const agent = await AgentModel.findById(agentId, user.id, isAgentAdmin);

      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      const newConversation = await ConversationModel.create({
        userId: user.id,
        organizationId,
        agentId: agent.id,
        selectedModel: sharedConversation.selectedModel,
        selectedProvider: sharedConversation.selectedProvider ?? undefined,
      });

      if (sharedConversation.messages.length > 0) {
        const messagesToCopy = sharedConversation.messages.map(
          (message: { role: string; content: unknown }) => ({
            conversationId: newConversation.id,
            role: message.role,
            content: message,
          }),
        );
        await MessageModel.bulkCreate(messagesToCopy);
      }

      const result = await ConversationModel.findById({
        id: newConversation.id,
        userId: user.id,
        organizationId,
      });

      if (!result) {
        throw new ApiError(500, "Failed to create forked conversation");
      }

      return result;
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
      const provider = isSupportedProvider(conversation.selectedProvider)
        ? conversation.selectedProvider
        : detectProviderFromModel(conversation.selectedModel);

      logger.debug(
        {
          conversationId: id,
          selectedProvider: conversation.selectedProvider,
          selectedModel: conversation.selectedModel,
          resolvedProvider: provider,
        },
        "Title generation: resolved provider",
      );

      // Resolve API key using the centralized function (handles all providers)
      const { apiKey, chatApiKeyId, baseUrl } = await resolveProviderApiKey({
        organizationId,
        userId: user.id,
        provider,
        conversationId: id,
      });

      logger.debug(
        {
          conversationId: id,
          provider,
          hasApiKey: !!apiKey,
          chatApiKeyId,
          baseUrl,
        },
        "Title generation: resolved API key",
      );

      if (isApiKeyRequired(provider, apiKey)) {
        throw new ApiError(
          400,
          "LLM Provider API key not configured. Please configure it in Provider Settings.",
        );
      }

      // Generate title using the extracted function
      const generatedTitle = await generateConversationTitle({
        provider,
        apiKey,
        chatApiKeyId,
        baseUrl,
        firstUserMessage,
        firstAssistantMessage,
      });

      if (!generatedTitle) {
        logger.warn(
          { conversationId: id, provider },
          "Title generation: returned null (generation failed)",
        );
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
        params: z.object({ id: z.string() }),
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
      // Use findByAnyId to support both DB UUIDs and AI SDK nanoid content IDs
      // (in-session messages retain their nanoid IDs until page reload)
      const message = await MessageModel.findByAnyId(id);

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
        message.id,
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

export function buildChatStopConditions() {
  return [
    stepCountIs(500),
    hasToolCall(getChatStopToolNames().swapAgentToolName),
    hasToolCall(getChatStopToolNames().swapToDefaultAgentToolName),
  ];
}

export function getChatStopToolNames() {
  return {
    swapAgentToolName: archestraMcpBranding.getToolName("swap_agent"),
    swapToDefaultAgentToolName: archestraMcpBranding.getToolName(
      "swap_to_default_agent",
    ),
  };
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
  provider: SupportedProvider;
  apiKey: string | undefined;
  chatApiKeyId?: string;
  baseUrl: string | null;
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
  const {
    provider,
    apiKey,
    chatApiKeyId,
    baseUrl,
    firstUserMessage,
    firstAssistantMessage,
  } = params;

  const modelName = await resolveFastModelName(provider, chatApiKeyId);

  logger.debug(
    { provider, modelName, chatApiKeyId, hasApiKey: !!apiKey, baseUrl },
    "Title generation: creating direct LLM model",
  );

  // Create model for title generation (direct call, not through LLM Proxy)
  const model = createDirectLLMModel({
    provider,
    apiKey,
    modelName,
    baseUrl,
  });

  const titlePrompt = buildTitlePrompt(firstUserMessage, firstAssistantMessage);

  try {
    logger.debug(
      { provider, modelName },
      "Title generation: calling generateText",
    );
    const result = await generateText({
      model,
      prompt: titlePrompt,
    });

    logger.debug(
      { provider, modelName, generatedTitle: result.text.trim() },
      "Title generation: generateText succeeded",
    );
    return result.text.trim();
  } catch (error) {
    logger.error(
      { error, provider, modelName, baseUrl },
      "Failed to generate conversation title",
    );
    return null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Persists new messages to the database for a conversation.
 * Strips images if browser streaming is enabled and handles empty message parts.
 *
 * @param conversationId - The conversation ID to persist messages for
 * @param messages - All messages (existing + new) to determine which ones to save
 * @param context - Context for logging (e.g., "onFinish", "onError")
 * @returns Promise<number> - Number of messages persisted
 */
async function persistNewMessages(
  conversationId: string,
  messages: unknown[],
  context: string,
): Promise<number> {
  try {
    // Get existing messages count to know how many are new
    const existingMessages =
      await MessageModel.findByConversation(conversationId);
    const uiMessages = messages as ChatMessage[];
    const newMessages = getMessagesNotYetPersisted({
      existingMessages,
      uiMessages,
    });

    if (newMessages.length === 0) {
      return 0;
    }

    // Check if last message has empty parts and strip it if so
    let messagesToSave = newMessages;
    if (newMessages[newMessages.length - 1].parts?.length === 0) {
      messagesToSave = newMessages.slice(0, -1);
    }

    if (messagesToSave.length === 0) {
      return 0;
    }

    let messagesToStore: ChatMessage[];

    // Strip base64 images and large browser tool results before storing
    if (context === "onFinish") {
      // Log size reduction only for onFinish (where we have complete messages)
      const beforeSize = estimateMessagesSize(messagesToSave);
      messagesToStore = normalizeChatMessages(messagesToSave);
      const afterSize = estimateMessagesSize(messagesToStore);

      logger.info(
        {
          messageCount: messagesToSave.length,
          beforeSizeKB: Math.round(beforeSize.length / 1024),
          afterSizeKB: Math.round(afterSize.length / 1024),
          savedKB: Math.round((beforeSize.length - afterSize.length) / 1024),
          sizeEstimateReliable:
            !beforeSize.isEstimated && !afterSize.isEstimated,
        },
        "[Chat] Stripped messages before saving to DB",
      );
    } else {
      // For onError, just strip without detailed logging
      messagesToStore = normalizeChatMessages(messagesToSave);
    }

    // Append only new messages with timestamps
    const now = Date.now();
    const messageData = messagesToStore.map((msg, index) => ({
      conversationId,
      role: msg.role ?? "assistant",
      content: msg,
      createdAt: new Date(now + index),
    }));

    await MessageModel.bulkCreate(messageData);

    logger.info(
      `Appended ${messagesToSave.length} new messages to conversation ${conversationId} (${context})`,
    );

    return messagesToSave.length;
  } catch (error) {
    logger.error(
      { error, conversationId, context },
      `Failed to persist messages during ${context}`,
    );
    throw error;
  }
}

function persistConversationChatError(params: {
  conversationId: string;
  error: ChatErrorResponse;
}) {
  const chatError = getSerializableChatError(params.error);

  void ConversationChatErrorModel.create({
    conversationId: params.conversationId,
    error: chatError,
  }).catch((error) => {
    logger.error(
      { error, conversationId: params.conversationId },
      "Failed to persist chat error event on conversation",
    );
  });
}

function getSerializableChatError(error: ChatErrorResponse): ChatErrorResponse {
  try {
    return JSON.parse(JSON.stringify(error)) as ChatErrorResponse;
  } catch {
    return getMinimalFrontendError(error);
  }
}

function getMessagesNotYetPersisted(params: {
  existingMessages: Array<{ id: string; content: unknown }>;
  uiMessages: ChatMessage[];
}): ChatMessage[] {
  const existingIds = new Set<string>();

  for (const message of params.existingMessages) {
    existingIds.add(message.id);

    // Persisted messages are re-keyed to DB UUIDs when conversations reload, but
    // in-flight useChat requests can still carry the original temporary content
    // ids. Track both forms so follow-up turns after swap_agent do not get
    // dropped just because the incoming thread is shorter than the DB thread.
    const contentId =
      typeof message.content === "object" &&
      message.content !== null &&
      "id" in message.content &&
      typeof message.content.id === "string"
        ? message.content.id
        : null;

    if (contentId) {
      existingIds.add(contentId);
    }
  }

  return params.uiMessages.filter((message) => {
    if (!message.id || typeof message.id !== "string") {
      return true;
    }

    return !existingIds.has(message.id);
  });
}

function prepareMessagesForProvider(params: {
  messages: ChatMessage[];
  provider: SupportedProvider;
}): ChatMessage[] {
  const { messages, provider } = params;

  if (provider === "anthropic") {
    return messages.map(normalizeAnthropicMessageFileParts);
  }

  if (provider === "bedrock") {
    return messages.map((message) =>
      ensureBedrockMessageHasContent(
        ensureBedrockUserMessageHasTextPart(message),
      ),
    );
  }

  return messages;
}

function normalizeAnthropicMessageFileParts(message: ChatMessage): ChatMessage {
  if (!message.parts?.length) {
    return message;
  }

  let changed = false;
  const parts = message.parts.map((part) => {
    const normalizedPart = normalizeAnthropicFilePart(part);
    if (normalizedPart !== part) {
      changed = true;
    }
    return normalizedPart;
  });

  return changed ? { ...message, parts } : message;
}

// Bedrock rejects user messages that contain a file/document block but no text
// block ("A text block must be included when using documents."). When the user
// sends a file with an empty prompt, prepend a placeholder so the request is
// accepted.
function ensureBedrockUserMessageHasTextPart(
  message: ChatMessage,
): ChatMessage {
  if (message.role !== "user" || !message.parts?.length) {
    return message;
  }

  let hasFilePart = false;
  let hasNonEmptyTextPart = false;
  for (const part of message.parts) {
    if (part.type === "file") {
      hasFilePart = true;
    } else if (
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0
    ) {
      hasNonEmptyTextPart = true;
    }
  }

  if (!hasFilePart || hasNonEmptyTextPart) {
    return message;
  }

  return {
    ...message,
    parts: [
      { type: "text", text: BEDROCK_DOCUMENT_PLACEHOLDER_TEXT },
      ...message.parts,
    ],
  };
}

// Bedrock also rejects messages whose content array is empty after the AI SDK
// drops empty text blocks and reasoning blocks without a signature ("The
// content field in the Message object at messages.N is empty"). Pad with
// placeholder text so turn alternation is preserved.
function ensureBedrockMessageHasContent(message: ChatMessage): ChatMessage {
  if (message.role === "system" || message.role === "tool") {
    return message;
  }
  if (message.parts?.some(producesBedrockContentBlock)) {
    return message;
  }

  const placeholder = {
    type: "text",
    text: BEDROCK_EMPTY_CONTENT_PLACEHOLDER_TEXT,
  };
  return {
    ...message,
    parts: message.parts ? [...message.parts, placeholder] : [placeholder],
  };
}

// Mirrors the AI SDK's bedrock converter: text/reasoning blocks without usable
// payload are silently dropped; everything else (tool-call, tool-result, file,
// image) always produces a content block.
function producesBedrockContentBlock(part: ChatMessagePart): boolean {
  if (part.type === "text") {
    return typeof part.text === "string" && part.text.trim().length > 0;
  }
  if (part.type === "reasoning") {
    const bedrock = (part.providerOptions as { bedrock?: unknown } | undefined)
      ?.bedrock as { signature?: unknown; redactedData?: unknown } | undefined;
    return Boolean(bedrock?.signature || bedrock?.redactedData);
  }
  return true;
}

const BEDROCK_DOCUMENT_PLACEHOLDER_TEXT =
  "Please review the attached document.";
const BEDROCK_EMPTY_CONTENT_PLACEHOLDER_TEXT = "(no content)";

function normalizeAnthropicFilePart(part: ChatMessagePart): ChatMessagePart {
  if (
    part.type !== "file" ||
    typeof part.mediaType !== "string" ||
    !isAnthropicTextDocumentMimeType(part.mediaType)
  ) {
    return part;
  }

  return {
    ...part,
    mediaType: "text/plain",
    url: normalizeDataUrlMediaType({
      url: typeof part.url === "string" ? part.url : undefined,
      fromMediaType: part.mediaType,
      toMediaType: "text/plain",
    }),
  };
}

function isAnthropicTextDocumentMimeType(mediaType: string): boolean {
  return (
    mediaType === "text/csv" ||
    mediaType === "text/markdown" ||
    mediaType === "application/csv" ||
    mediaType === "application/vnd.ms-excel"
  );
}

function normalizeDataUrlMediaType(params: {
  url: string | undefined;
  fromMediaType: string;
  toMediaType: string;
}): string | undefined {
  const { url, fromMediaType, toMediaType } = params;

  if (!url?.startsWith(`data:${fromMediaType};`)) {
    return url;
  }

  return url.replace(`data:${fromMediaType};`, `data:${toMediaType};`);
}

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
  const apiKey = await LlmProviderApiKeyModel.findById(chatApiKeyId);
  if (!apiKey || apiKey.organizationId !== organizationId) {
    throw new ApiError(404, "Chat API key not found");
  }

  // Verify user has access to the API key based on scope
  const userTeamIds = await TeamModel.getUserTeamIds(userId);
  const canAccessKey =
    apiKey.scope === "org" ||
    (apiKey.scope === "personal" && apiKey.userId === userId) ||
    (apiKey.scope === "team" &&
      apiKey.teamId &&
      userTeamIds.includes(apiKey.teamId));

  if (!canAccessKey) {
    throw new ApiError(403, "You do not have access to this API key");
  }
}

export const __test = {
  getMessagesNotYetPersisted,
  prepareMessagesForProvider,
};

export default chatRoutes;
