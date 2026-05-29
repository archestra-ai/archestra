import { randomUUID } from "node:crypto";
import {
  buildUserSystemPromptContext,
  type ChatErrorResponse,
  isModelSelectionComplete,
  ResourceVisibilityScopeSchema,
  RouteId,
  type SupportedProvider,
  TimeInMs,
  type TokenUsage,
} from "@shared";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  generateText,
  hasToolCall,
  NoSuchToolError,
  stepCountIs,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { hasAnyAgentTypeAdminPermission, userHasPermission } from "@/auth";
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
  isApiKeyRequired,
} from "@/clients/llm-client";
import config from "@/config";
import { withDbTransaction } from "@/database";
import { browserStreamFeature } from "@/features/browser-stream/services/browser-stream.feature";
import { extractAndIngestDocuments } from "@/knowledge-base";
import { fileUploadManager } from "@/knowledge-base/file-upload/file-upload-manager";
import logger from "@/logging";
import {
  ActiveChatRunModel,
  AgentModel,
  ConversationAttachmentModel,
  ConversationChatErrorModel,
  ConversationEnabledToolModel,
  ConversationModel,
  ConversationShareModel,
  LlmProviderApiKeyModel,
  MemberModel,
  MessageModel,
  OrganizationModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  TeamModel,
} from "@/models";
import { startActiveChatSpan } from "@/observability/tracing";
import {
  ACTIVE_CHAT_RUN_TERMINAL_REPLAY_GRACE_MS,
  activeChatRunService,
} from "@/services/active-chat-run";
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
  SelectConversationCompactionSchema,
  SelectConversationSchema,
  SelectConversationShareWithTargetsSchema,
  type UpdateConversation,
  UpdateConversationSchema,
  UuidIdSchema,
} from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import {
  resolveConversationLlmSelectionForAgent,
  resolveConversationModel,
  resolveFastModelName,
} from "@/utils/llm-resolution";
import { estimateMessagesSize } from "@/utils/message-size";
import {
  isSafeInlineMimeType,
  sanitizeAttachmentContentType,
} from "./attachment-content-type";
import {
  buildContextCompactionStreamData,
  compactMessagesForChat,
  invalidateConversationCompactions,
} from "./context-compaction";
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
import { injectSkillActivation } from "./inject-skill-activation";
import { cloneAttachmentsForFork } from "./normalization/clone-attachments-for-fork";
import { extractInlineAttachments } from "./normalization/extract-inline-attachments";
import { materializeAttachments } from "./normalization/materialize-attachments";
import { normalizeChatMessages } from "./normalization/normalize-chat-messages";

const PromoteChatAttachmentResultSchema = z.object({
  filename: z.string(),
  status: z.enum([
    "created",
    "duplicate",
    "unsupported",
    "too_large",
    "extraction_failed",
    "failed",
  ]),
  fileId: z.string().optional(),
});

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

const UNAVAILABLE_TOOL_ERROR_MESSAGE =
  "The requested tool is not available in this chat. Available tools are listed in the details below; use an exact available tool name for the next tool call.";

type UnavailableToolErrorDetails = {
  type: "unavailable_tool";
  message: string;
  requestedToolName: string;
  availableToolNames: string[];
  originalErrorMessage: string;
};

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
      let activeRunError: string | null = null;

      // Per-stream id. The stop signal is keyed by this id (not by conversationId)
      // so a stale stop flag from an earlier stream can never abort a later one.
      const streamId = randomUUID();
      const activeStreamKey =
        `${CacheKey.ChatActiveStream}-${conversationId}` as const;
      let removeAbortListeners = () => {};

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

      const activeRun = await activeChatRunService.createRun({
        conversationId,
        userId: user.id,
        organizationId,
      });

      if (!activeRun) {
        throw new ApiError(
          409,
          "This conversation already has an active response. Stop it before sending another message.",
        );
      }

      // Extract any inline data: URL file parts into chat_attachments so the
      // bytes never enter the messages.content JSONB row. Runs after both
      // the conversation existence+ownership check and the active-run
      // acquisition so we don't write rows for requests that would
      // 404/403/409. After this, parts[] carry tiny refs
      // (`/api/chat/attachments/:id/content`); the LLM-call path rehydrates
      // inline only at send time (see materializeAttachments inside
      // buildModelMessagesForProvider).
      // Wrapped in markTerminal cleanup: a throw here would otherwise leave
      // the active run stuck `running`, causing subsequent sends to 409.
      try {
        await extractInlineAttachments({
          messages: messages as ChatMessage[],
          conversationId,
          organizationId,
          uploadedByUserId: user.id,
        });
      } catch (error) {
        await ActiveChatRunModel.markTerminal({
          runId: activeRun.id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const stopActiveRunPolling = activeChatRunService.startStopPolling({
        runId: activeRun.id,
        conversationId,
        abortController: chatAbortController,
      });

      // Awaited (not fire-and-forget): the stop endpoint resolves this mapping
      // to find the stream to abort, and the stream starts producing output
      // immediately after. If registration lagged, an early stop would read no
      // mapping and silently no-op. A write failure only degrades stop for this
      // stream, so it is logged rather than failing the request.
      // The TTL must outlive the stream (a newer stream overwrites this entry,
      // a finished one leaves a harmless stale mapping), so it is not refreshed.
      try {
        await cacheManager.set(activeStreamKey, streamId, TimeInMs.Hour);
      } catch (error) {
        logger.warn(
          { error, conversationId, streamId },
          "Failed to register active chat stream",
        );
      }

      // When the HTTP connection closes (stop button or navigate away), check if
      // a stop was explicitly requested via the distributed cache. This works across
      // pods because the cache is PostgreSQL-backed: the stop endpoint sets the flag
      // (possibly on a different pod), then the frontend's stop() closes the stream
      // connection which fires on THIS pod where the stream is running.
      removeAbortListeners = attachRequestAbortListeners({
        request,
        reply,
        abortController: chatAbortController,
        conversationId,
        streamId,
      });

      try {
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
        const [
          enabledToolIds,
          hasCustomSelection,
          slimChatErrorUi,
          organization,
        ] = await Promise.all([
          ConversationEnabledToolModel.findByConversation(conversationId),
          ConversationEnabledToolModel.hasCustomSelection(conversationId),
          OrganizationModel.getSlimChatErrorUi(organizationId),
          OrganizationModel.getById(organizationId),
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

        // The conversation stores a model_id FK; dereference it to the
        // proxy-facing model string + provider (env/config fallback if unset).
        const { model: selectedModel, provider } =
          await resolveConversationModel(conversation.modelId);

        logger.info(
          {
            conversationId,
            agentId,
            userId: user.id,
            orgId: organizationId,
            toolCount: Object.keys(mcpTools).length,
            hasCustomToolSelection: hasCustomSelection,
            enabledToolCount: hasCustomSelection
              ? enabledToolIds.length
              : "all",
            model: selectedModel,
            provider,
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
              model: selectedModel,
              provider,
              conversationId,
              externalAgentId,
              sessionId: conversationId,
              source: "chat",
              agentLlmApiKeyId: agent.llmApiKeyId,
            });

            // When a user invoked a skill via slash command, inject its content
            // into a copy of the messages before they reach the model. The
            // original `messages` stay clean for persistence and the visible bubble.
            // Slash commands depend on skill tools (the injected block references
            // read_skill_file), so both org flags must be on.
            const skillSlashCommandsActive =
              !!organization?.skillSlashCommandsEnabled &&
              !!organization?.skillToolsEnabled;
            const messagesForLLM = skillSlashCommandsActive
              ? await injectSkillActivation({
                  messages: messages as ChatMessage[],
                  organizationId,
                  userId: user.id,
                })
              : (messages as ChatMessage[]);

            // Normalize chat history before replaying it to the model.
            // This dedupes repeated tool parts, drops dangling interrupted tool calls,
            // and strips heavy image/browser payloads that would otherwise bloat context.
            const normalizedMessagesForLLM =
              normalizeChatMessages(messagesForLLM);

            // Perplexity does NOT support tool calling - it has built-in web search instead
            // @see https://docs.perplexity.ai/api-reference/chat-completions-post
            const supportsToolCalling = provider !== "perplexity";

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
            const modelLower = selectedModel.toLowerCase();
            const isGeminiImageModel =
              provider === "gemini" &&
              (modelLower.includes("image") ||
                modelLower.includes("native-audio-dialog"));

            // Persist user's new messages immediately so they're visible on page reload.
            // Without this, a reload during streaming shows no messages because
            // onFinish hasn't fired yet. persistNewMessages is idempotent — it only
            // saves messages beyond the existing count, so onFinish will only save
            // the assistant response.
            try {
              await persistNewMessages(
                conversationId,
                messages,
                "earlyUserMsg",
              );
            } catch (error) {
              logger.warn(
                { error, conversationId },
                "Failed to persist user messages early (will retry in onFinish)",
              );
            }

            // Create stream with token usage data support
            const uiMessageStream = createUIMessageStream({
              // Preserve incoming message IDs so the client updates existing
              // assistant messages instead of rendering duplicate ones.
              originalMessages: messages as UIMessage[],
              onError: (error) => {
                // unlike the tool-level stream handler, a NoSuchToolError here
                // is not a recoverable tool result: it must mark the run failed
                // and persist, so it falls through to the normal error path.
                activeRunError =
                  error instanceof Error ? error.message : String(error);
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
                const streamTextOnChunk: NonNullable<
                  Parameters<typeof streamText>[0]["onChunk"]
                > = ({ chunk }) => {
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

                let compactionStarted = false;
                const compactionResult = await compactMessagesForChat({
                  conversationId,
                  organizationId,
                  userId: user.id,
                  agentId: conversation.agentId,
                  provider,
                  selectedModel,
                  agentLlmApiKeyId: agent.llmApiKeyId,
                  messages: normalizedMessagesForLLM,
                  systemPrompt,
                  trigger: "auto",
                  abortSignal: chatAbortController.signal,
                  onCompactionStart: () => {
                    compactionStarted = true;
                    writer.write({
                      type: "data-context-compaction-start",
                      data: { trigger: "auto" },
                    });
                  },
                });

                if (
                  compactionStarted ||
                  compactionResult.status === "created" ||
                  compactionResult.status === "failed"
                ) {
                  writer.write({
                    type: "data-context-compaction-finish",
                    data: buildContextCompactionStreamData(compactionResult),
                  });
                }

                const modelMessages = await buildModelMessagesForProvider({
                  messages: compactionResult.messages,
                  provider,
                  conversationId,
                });
                const streamTextConfig: Parameters<typeof streamText>[0] = {
                  model,
                  messages: modelMessages,
                  ...(supportsToolCalling && { tools: mcpTools }),
                  stopWhen: buildChatStopConditions(),
                  abortSignal: chatAbortController.signal,
                  onChunk: streamTextOnChunk,
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

                if (isGeminiImageModel) {
                  streamTextConfig.providerOptions = {
                    google: {
                      responseModalities: ["TEXT", "IMAGE"],
                    },
                  };
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
                    // Give the streamed assistant message a stable id. Without
                    // generateMessageId the AI SDK leaves the response message
                    // id empty, so the persisted assistant row can't be matched
                    // when the approval resume re-sends the turn — the resolved
                    // turn is appended as new rows while the original
                    // approval-requested row is orphaned and re-renders a stale
                    // prompt on reload (#4030).
                    generateMessageId: generateId,
                    onError: (error) => {
                      const unavailableToolError =
                        getUnavailableToolErrorDetails(error);
                      if (unavailableToolError) {
                        logger.info(
                          {
                            conversationId,
                            unavailableToolError,
                          },
                          "Returning unavailable tool error as tool-level error",
                        );
                        return formatUnavailableToolErrorDetails(
                          unavailableToolError,
                        );
                      }

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

                      activeRunError =
                        error instanceof Error ? error.message : String(error);
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
                      stopActiveRunPolling();

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
            });

            const [responseStream, persistenceStream] = uiMessageStream.tee();
            activeChatRunService.drainStreamToEvents({
              runId: activeRun.id,
              conversationId,
              stream: persistenceStream as ReadableStream<UIMessageChunk>,
              abortController: chatAbortController,
              getTerminalStatus: async () => {
                const latestRun = await ActiveChatRunModel.findById(
                  activeRun.id,
                );
                if (latestRun?.stopRequestedAt) {
                  return { status: "cancelled" };
                }
                if (activeRunError) {
                  return { status: "failed", error: activeRunError };
                }
                if (chatAbortController.signal.aborted) {
                  return { status: "cancelled" };
                }
                return { status: "completed" };
              },
            });

            const response = createUIMessageStreamResponse({
              headers: {
                // Prevent compression middleware from buffering the stream
                // See: https://ai-sdk.dev/docs/troubleshooting/streaming-not-working-when-proxied
                "Content-Encoding": "none",
              },
              stream: responseStream as ReadableStream<UIMessageChunk>,
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
      } catch (error) {
        if (!chatAbortController.signal.aborted) {
          chatAbortController.abort();
        }
        stopActiveRunPolling();
        await ActiveChatRunModel.markTerminal({
          runId: activeRun.id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
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
    async ({ params: { id }, user, organizationId }, reply) => {
      // Owner-only: stop is a mutation on someone else's in-flight LLM work, so
      // share-access (which is enough to read or reconnect to the stream) must
      // not be enough to abort it.
      const conversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      const activeRun = await activeChatRunService.requestStop({
        conversationId: id,
        organizationId,
      });

      // Resolve the conversation's currently-running stream, then set a stop flag
      // keyed by that stream's id. Keying by streamId (rather than conversationId)
      // ensures the flag can only ever abort the stream it was meant for — a stale
      // flag from an earlier stream targets a different id and is harmless.
      // The flag lives in the distributed cache so any pod can detect it on
      // connection close, even when the stream runs on a different pod.
      const activeStreamKey = `${CacheKey.ChatActiveStream}-${id}` as const;
      const streamId = await cacheManager.get<string>(activeStreamKey);
      if (!streamId) {
        return reply.send({ stopped: !!activeRun });
      }
      const stopKey = `${CacheKey.ChatStop}-${streamId}` as const;
      try {
        await cacheManager.set(stopKey, true, TimeInMs.Minute);
      } catch (error) {
        logger.warn(
          { error, conversationId: id, streamId },
          "Failed to set chat stop cache flag",
        );
      }
      return reply.send({ stopped: true });
    },
  );

  fastify.get(
    "/api/chat/conversations/:id/active-run",
    {
      schema: {
        operationId: RouteId.GetActiveChatRun,
        description: "Reconnect to an active chat stream for a conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: {
          200: z.unknown(),
          204: z.undefined(),
          ...ErrorResponsesSchema,
        },
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const conversation = await ConversationModel.findAccessibleById({
        id,
        userId: user.id,
        organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      const activeRun = await ActiveChatRunModel.findReplayableByConversation({
        conversationId: id,
        organizationId,
        terminalGraceMs: ACTIVE_CHAT_RUN_TERMINAL_REPLAY_GRACE_MS,
      });

      if (!activeRun) {
        return reply.status(204).send();
      }

      const response = createUIMessageStreamResponse({
        headers: {
          "Content-Encoding": "none",
        },
        stream: activeChatRunService.createReplayStream(activeRun.id),
      });

      for (const [key, value] of response.headers.entries()) {
        reply.header(key, value);
      }

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
      const conversation = await findReadableConversationById({
        conversationId: id,
        userId: user.id,
        organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      return reply.send(conversation);
    },
  );

  fastify.get(
    "/api/chat/attachments/:id/content",
    {
      schema: {
        operationId: RouteId.GetChatAttachmentContent,
        description:
          "Stream the bytes of a chat attachment by id. Auth'd to the org.",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: ErrorResponsesSchema,
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      // Fetch metadata first (no fileData) so unauthorized requests don't
      // trigger a large bytea read before the 403. Only load the blob once
      // org + per-conversation access has been confirmed.
      const meta = await ConversationAttachmentModel.findById(id);
      if (!meta) {
        throw new ApiError(404, "Attachment not found");
      }
      if (meta.organizationId !== organizationId) {
        throw new ApiError(403, "Attachment belongs to a different org");
      }

      // Verify the requester can read the conversation that owns this
      // attachment. Without this check, any org member with chat:read could
      // fetch any attachment in the org regardless of per-conversation ACLs.
      const conversation = await findReadableConversationById({
        conversationId: meta.conversationId,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        throw new ApiError(403, "No access to the owning conversation");
      }

      const attachment = await ConversationAttachmentModel.findByIdWithData(id);
      if (!attachment) {
        // Soft-deleted between the metadata check and the blob fetch.
        throw new ApiError(404, "Attachment not found");
      }

      const safeMime = sanitizeAttachmentContentType(attachment.mimeType);
      const disposition = isSafeInlineMimeType(safeMime)
        ? "inline"
        : "attachment";
      // Bypass fastify-zod's response schema (declared as the error union
      // only) for the binary success body by writing directly to the
      // underlying Node response. `reply.hijack()` tells Fastify to step
      // back so its response serializer doesn't run against a Buffer.
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": safeMime,
        "Content-Disposition": `${disposition}; filename="${encodeURIComponent(attachment.originalName)}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=3600",
        "Content-Length": String(attachment.fileSize),
      });
      reply.raw.end(attachment.fileData);
      return reply;
    },
  );

  fastify.post(
    "/api/chat/attachments/:id/promote-to-knowledge-file",
    {
      schema: {
        operationId: RouteId.PromoteChatAttachmentToKnowledgeFile,
        description:
          "Promote a conversation attachment into a reusable Knowledge File",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: z.object({
          visibility: ResourceVisibilityScopeSchema.default("personal"),
          teamIds: z.array(z.string()).default([]),
          agentIds: z.array(z.string()).default([]),
        }),
        response: constructResponseSchema(PromoteChatAttachmentResultSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const attachment = await ConversationAttachmentModel.findByIdWithData(id);
      if (!attachment) {
        throw new ApiError(404, "Attachment not found");
      }
      if (attachment.organizationId !== organizationId) {
        throw new ApiError(404, "Attachment not found");
      }

      const conversation = await findReadableConversationById({
        conversationId: attachment.conversationId,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        throw new ApiError(404, "Attachment not found");
      }

      const result = await fileUploadManager.uploadKnowledgeFile({
        organizationId,
        userId: user.id,
        name: attachment.originalName,
        mimeType: attachment.mimeType,
        contentBuffer: attachment.fileData,
        visibility: body.visibility,
        teamIds: body.teamIds,
        agentIds: body.agentIds,
      });

      return reply.send(result);
    },
  );

  fastify.post(
    "/api/chat/conversations/:id/fork",
    {
      schema: {
        operationId: RouteId.ForkChatConversation,
        description:
          "Create a new conversation from an accessible conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: z.object({
          agentId: z.string().uuid(),
        }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({ params: { id }, body: { agentId }, user, organizationId }) => {
      const sourceConversation = await findReadableConversationById({
        conversationId: id,
        userId: user.id,
        organizationId,
      });

      if (!sourceConversation) {
        throw new ApiError(404, "Conversation not found");
      }

      return await forkConversation({
        sourceConversation,
        agentId,
        userId: user.id,
        organizationId,
      });
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
          modelId: true,
          chatApiKeyId: true,
        })
          .required({ agentId: true })
          .partial({
            title: true,
            modelId: true,
            chatApiKeyId: true,
          }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async (
      { body: { agentId, title, modelId, chatApiKeyId }, user, organizationId },
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

      // Resolve the model via the priority chain:
      // explicit pick -> member -> agent -> organization -> best available.
      // The explicit pick is a (model, key) pair — both are carried so the
      // chosen key is honored instead of being re-derived.
      const llmSelection = await resolveConversationLlmSelectionForAgent({
        agent: { llmApiKeyId: agent.llmApiKeyId, modelId: agent.modelId },
        organizationId,
        userId: user.id,
        explicitModelId: modelId,
        explicitApiKeyId: chatApiKeyId,
      });

      logger.info(
        {
          agentId,
          organizationId,
          explicitModelId: modelId,
          resolvedModelId: llmSelection.modelId,
          selectedModel: llmSelection.selectedModel,
          chatApiKeyId,
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
          modelId: llmSelection.modelId,
          chatApiKeyId: llmSelection.chatApiKeyId,
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

        if (body.modelId === undefined && body.chatApiKeyId === undefined) {
          const llmSelection = await resolveConversationLlmSelectionForAgent({
            agent: {
              llmApiKeyId: agent.llmApiKeyId ?? null,
              modelId: agent.modelId ?? null,
            },
            organizationId,
            userId: user.id,
          });

          body.modelId = llmSelection.modelId;
          body.chatApiKeyId = llmSelection.chatApiKeyId;
        }
      }

      // A conversation's model and API key are a pair: persist both or
      // neither. Validate the merged result only when this update touches
      // either field.
      if (body.modelId !== undefined || body.chatApiKeyId !== undefined) {
        const currentConversation = await ConversationModel.findById({
          id,
          userId: user.id,
          organizationId,
        });
        const mergedModelId =
          body.modelId !== undefined
            ? body.modelId
            : (currentConversation?.modelId ?? null);
        const mergedApiKeyId =
          body.chatApiKeyId !== undefined
            ? body.chatApiKeyId
            : (currentConversation?.chatApiKeyId ?? null);
        if (
          !isModelSelectionComplete({
            modelId: mergedModelId,
            apiKeyId: mergedApiKeyId,
          })
        ) {
          throw new ApiError(
            400,
            "A conversation's model and API key must be set together",
          );
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

  fastify.post(
    "/api/chat/conversations/:id/compact",
    {
      schema: {
        operationId: RouteId.CompactChatConversation,
        description: "Compact older chat history for model context",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(
          z.object({
            status: z.enum(["created", "existing", "skipped", "failed"]),
            reason: z.string().optional(),
            compaction: SelectConversationCompactionSchema.nullable(),
            conversation: SelectConversationSchema,
          }),
        ),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const conversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      if (!conversation.agentId || !conversation.agent) {
        throw new ApiError(
          400,
          "The agent associated with this conversation has been deleted",
        );
      }

      // Resolve the conversation's stored model_id FK to the proxy-facing
      // model string + provider (env/config fallback if unset). Mirrors the
      // chat-stream route's resolution so compaction sees the same model.
      const { model: selectedModel, provider } = await resolveConversationModel(
        conversation.modelId,
      );
      const normalizedMessages = normalizeChatMessages(
        conversation.messages as ChatMessage[],
      );
      const result = await compactMessagesForChat({
        conversationId: id,
        organizationId,
        userId: user.id,
        agentId: conversation.agentId,
        provider,
        selectedModel,
        agentLlmApiKeyId: conversation.agent.llmApiKeyId,
        messages: normalizedMessages,
        systemPrompt: conversation.agent.systemPrompt ?? undefined,
        trigger: "manual",
      });
      const updatedConversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });

      if (!updatedConversation) {
        throw new ApiError(500, "Failed to retrieve compacted conversation");
      }

      return reply.send({
        status: result.status,
        reason: result.reason,
        compaction: result.compaction,
        conversation: updatedConversation,
      });
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

      return await forkConversation({
        sourceConversation: sharedConversation,
        agentId,
        userId: user.id,
        organizationId,
      });
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

      // Use the conversation's model provider for title generation so the
      // title is generated with the same provider as the chat.
      const { provider } = await resolveConversationModel(conversation.modelId);

      logger.debug(
        { conversationId: id, resolvedProvider: provider },
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

      // run the message edit, optional subsequent-message deletion, and
      // compaction invalidation inside one transaction so a crash can't leave
      // stale compactions pointing at a now-edited or truncated history
      await withDbTransaction(async (tx) => {
        await MessageModel.updateTextPartAndDeleteSubsequent(
          message.id,
          partIndex,
          text,
          deleteSubsequentMessages ?? false,
          tx,
        );
        await invalidateConversationCompactions(message.conversationId, tx);
      });

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

function getUnavailableToolErrorDetails(
  error: unknown,
): UnavailableToolErrorDetails | null {
  if (!NoSuchToolError.isInstance(error)) {
    return null;
  }

  return {
    type: "unavailable_tool",
    message: UNAVAILABLE_TOOL_ERROR_MESSAGE,
    requestedToolName: error.toolName,
    availableToolNames: error.availableTools ?? [],
    originalErrorMessage: error.message,
  };
}

function formatUnavailableToolErrorDetails(
  details: UnavailableToolErrorDetails,
): string {
  return `${details.message}\n\nDetails:\n${JSON.stringify(
    {
      type: details.type,
      requestedToolName: details.requestedToolName,
      availableToolNames: details.availableToolNames,
      originalErrorMessage: details.originalErrorMessage,
    },
    null,
    2,
  )}`;
}

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
    // Fetch existing messages to classify incoming ones as new or changed
    const existingMessages =
      await MessageModel.findByConversation(conversationId);
    const uiMessages = messages as ChatMessage[];
    const newMessages = getMessagesNotYetPersisted({
      existingMessages,
      uiMessages,
    });

    // Tool approvals resolve after the assistant message is first persisted.
    // Only the onFinish persist carries the server-authoritative final
    // messages, so content updates are applied from that path alone.
    const changedMessages: Array<{ id: string; content: ChatMessage }> =
      context === "onFinish"
        ? getMessagesWithChangedContent({ existingMessages, uiMessages })
        : [];

    if (newMessages.length === 0 && changedMessages.length === 0) {
      return 0;
    }

    let persistedCount = 0;

    if (newMessages.length > 0) {
      // Check if last message has empty parts and strip it if so
      let messagesToSave = newMessages;
      if (newMessages[newMessages.length - 1].parts?.length === 0) {
        messagesToSave = newMessages.slice(0, -1);
      }

      if (messagesToSave.length > 0) {
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
              savedKB: Math.round(
                (beforeSize.length - afterSize.length) / 1024,
              ),
              sizeEstimateReliable:
                !beforeSize.isEstimated && !afterSize.isEstimated,
            },
            "[Chat] Stripped messages before saving to DB",
          );
        } else {
          // For onError, just strip without detailed logging
          messagesToStore = normalizeChatMessages(messagesToSave);
        }

        const now = Date.now();
        const messageData = messagesToStore.map((msg, index) => ({
          conversationId,
          role: msg.role ?? "assistant",
          content: msg,
          createdAt: new Date(now + index),
        }));

        await MessageModel.bulkCreate(messageData);
        persistedCount += messagesToSave.length;

        logger.info(
          `Appended ${messagesToSave.length} new messages to conversation ${conversationId} (${context})`,
        );
      }
    }

    // Persist content updates for messages that already exist but changed
    // (e.g. an assistant turn whose tool call was approved or declined).
    for (const changedMessage of changedMessages) {
      await MessageModel.updateContent(
        changedMessage.id,
        changedMessage.content,
      );
    }

    if (changedMessages.length > 0) {
      logger.info(
        `Updated ${changedMessages.length} changed messages in conversation ${conversationId} (${context})`,
      );
    }

    return persistedCount + changedMessages.length;
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
  const existingEmptyContentIdSignatures = new Map<string, number>();

  for (const message of params.existingMessages) {
    if (message.id) {
      existingIds.add(message.id);
    }

    // Persisted messages are re-keyed to DB UUIDs when conversations reload, but
    // in-flight useChat requests can still carry the original temporary content
    // ids. Track both forms so follow-up turns after swap_agent do not get
    // dropped just because the incoming thread is shorter than the DB thread.
    const contentId = getMessageContentId(message.content);

    if (contentId && contentId.length > 0) {
      existingIds.add(contentId);
      continue;
    }

    if (contentId === "") {
      const signature = getMessageTextSignature(message.content);
      if (signature) {
        existingEmptyContentIdSignatures.set(
          signature,
          (existingEmptyContentIdSignatures.get(signature) ?? 0) + 1,
        );
      }
    }
  }

  return params.uiMessages.filter((message) => {
    const messageIds = getUiMessageIdentityIds(message);
    if (messageIds.some((id) => existingIds.has(id))) {
      return false;
    }

    const signature = getMessageTextSignature(message);
    if (signature) {
      const remainingMatches =
        existingEmptyContentIdSignatures.get(signature) ?? 0;
      if (remainingMatches > 0) {
        if (remainingMatches === 1) {
          existingEmptyContentIdSignatures.delete(signature);
        } else {
          existingEmptyContentIdSignatures.set(signature, remainingMatches - 1);
        }
        return false;
      }
    }

    return true;
  });
}

const TERMINAL_TOOL_STATES: ReadonlySet<string> = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

/**
 * Returns the stored rows that should be overwritten in place by an incoming
 * message — specifically, an assistant turn whose tool call is still in
 * `approval-requested` state and whose `toolCallId` arrives in a terminal
 * state (`output-available`, `output-error`, `output-denied`).
 *
 * Scoped tightly to the approval-resolution flow so this update path cannot
 * be repurposed to overwrite arbitrary earlier messages whose parts happen
 * to differ — those edits still go through `updateTextPartAndDeleteSubsequent`.
 */
function getMessagesWithChangedContent(params: {
  existingMessages: Array<{ id: string; content: unknown }>;
  uiMessages: ChatMessage[];
}): Array<{ id: string; content: ChatMessage }> {
  // Index stored rows by the toolCallId of any approval-requested tool part
  // they carry — those are the only rows this update path can target.
  const pendingByToolCallId = new Map<
    string,
    { id: string; content: unknown }
  >();
  for (const existing of params.existingMessages) {
    if (typeof existing.content !== "object" || existing.content === null) {
      continue;
    }
    const parts = (existing.content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { state?: unknown }).state === "approval-requested" &&
        typeof (part as { toolCallId?: unknown }).toolCallId === "string"
      ) {
        pendingByToolCallId.set(
          (part as { toolCallId: string }).toolCallId,
          existing,
        );
      }
    }
  }
  if (pendingByToolCallId.size === 0) {
    return [];
  }

  const changedMessages: Array<{ id: string; content: ChatMessage }> = [];
  for (const incoming of normalizeChatMessages(params.uiMessages)) {
    for (const part of incoming.parts ?? []) {
      const state = (part as { state?: unknown }).state;
      if (typeof state !== "string" || !TERMINAL_TOOL_STATES.has(state)) {
        continue;
      }
      const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId !== "string") continue;
      const stored = pendingByToolCallId.get(toolCallId);
      if (!stored) continue;
      changedMessages.push({ id: stored.id, content: incoming });
      // Each approval-requested row resolves at most once per sweep.
      pendingByToolCallId.delete(toolCallId);
      break;
    }
  }

  return changedMessages;
}

function getMessageContentId(content: unknown): string | null {
  if (
    typeof content === "object" &&
    content !== null &&
    "id" in content &&
    typeof content.id === "string"
  ) {
    return content.id;
  }

  return null;
}

function getUiMessageIdentityIds(message: ChatMessage): string[] {
  const ids = new Set<string>();
  if (message.id && typeof message.id === "string") {
    ids.add(message.id);
  }

  const persistedMessageId = getMessagePersistedMetadataId(message);
  if (persistedMessageId) {
    ids.add(persistedMessageId);
  }

  return [...ids];
}

function getMessagePersistedMetadataId(message: ChatMessage): string | null {
  if (
    !("metadata" in message) ||
    typeof message.metadata !== "object" ||
    message.metadata === null ||
    !("persistedMessageId" in message.metadata) ||
    typeof message.metadata.persistedMessageId !== "string" ||
    message.metadata.persistedMessageId.length === 0
  ) {
    return null;
  }

  return message.metadata.persistedMessageId;
}

function getMessageTextSignature(message: unknown): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const role =
    "role" in message && typeof message.role === "string" ? message.role : null;
  const parts =
    "parts" in message && Array.isArray(message.parts) ? message.parts : null;

  if (!role || !parts) {
    return null;
  }

  const text = parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");

  if (!text) {
    return null;
  }

  return `${role}\u0000${text}`;
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

async function buildModelMessagesForProvider(params: {
  messages: ChatMessage[];
  provider: SupportedProvider;
  conversationId: string;
}) {
  // Re-inline attachment refs as base64 data URLs for the LLM call (with
  // Anthropic cache_control marker). Refs are filtered to attachments owned
  // by `conversationId` so a client can't reference another conversation's
  // attachment id. Legacy inline data URLs pass through unchanged. Returns a
  // deep copy — the original messages keep their refs for any subsequent
  // persistence step.
  const materialized = await materializeAttachments(
    params.messages,
    params.conversationId,
  );
  const providerPreparedMessages = prepareMessagesForProvider({
    messages: materialized,
    provider: params.provider,
  });

  // Cast to UIMessage[] - ChatMessage is structurally compatible at runtime.
  return await convertToModelMessages(
    providerPreparedMessages as unknown as Omit<UIMessage, "id">[],
  );
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

/**
 * Workaround for AI SDK Bedrock conversion sending empty assistant content.
 *
 * The AI SDK can split assistant UI messages at `step-start` boundaries, then
 * drop provider-invisible parts during Bedrock conversion and send
 * `content: []`. Keep this until the upstream provider fix is released:
 * https://github.com/vercel/ai/issues/15248
 * https://github.com/vercel/ai/pull/15250
 */
function ensureBedrockMessageHasContent(message: ChatMessage): ChatMessage {
  if (message.role === "system" || message.role === "tool") {
    return message;
  }
  if (message.role === "assistant") {
    return ensureBedrockAssistantMessageHasContent(message);
  }
  if (message.parts?.some(producesBedrockContentBlock)) {
    return message;
  }

  return {
    ...message,
    parts: message.parts
      ? [...message.parts, createBedrockEmptyContentPlaceholder()]
      : [createBedrockEmptyContentPlaceholder()],
  };
}

function ensureBedrockAssistantMessageHasContent(
  message: ChatMessage,
): ChatMessage {
  if (!message.parts?.length) {
    return {
      ...message,
      parts: [createBedrockEmptyContentPlaceholder()],
    };
  }

  let changed = false;
  let blockHasAnyPart = false;
  let blockHasContent = false;
  const parts: ChatMessagePart[] = [];

  const padCurrentBlockIfEmpty = () => {
    if (blockHasAnyPart && !blockHasContent) {
      parts.push(createBedrockEmptyContentPlaceholder());
      changed = true;
    }
    blockHasAnyPart = false;
    blockHasContent = false;
  };

  for (const part of message.parts) {
    if (part.type === "step-start") {
      padCurrentBlockIfEmpty();
      parts.push(part);
      continue;
    }

    parts.push(part);
    blockHasAnyPart = true;
    if (producesBedrockContentBlock(part)) {
      blockHasContent = true;
    }
  }

  padCurrentBlockIfEmpty();

  return changed ? { ...message, parts } : message;
}

function createBedrockEmptyContentPlaceholder(): ChatMessagePart {
  return {
    type: "text",
    text: BEDROCK_EMPTY_CONTENT_PLACEHOLDER_TEXT,
  };
}

// Mirrors the AI SDK's UI-to-model conversion plus Bedrock's converter:
// data/control parts are ignored without a converter, streaming tool inputs are
// dropped, and empty text/reasoning blocks are not provider-visible content.
function producesBedrockContentBlock(part: ChatMessagePart): boolean {
  if (part.type === "text") {
    return typeof part.text === "string" && part.text.trim().length > 0;
  }
  if (part.type === "file") {
    return true;
  }
  if (part.type === "reasoning") {
    const providerMetadata =
      (part.providerMetadata as { bedrock?: unknown } | undefined) ??
      (part.providerOptions as { bedrock?: unknown } | undefined);
    const bedrock = providerMetadata?.bedrock as
      | { signature?: unknown; redactedData?: unknown }
      | undefined;
    return Boolean(bedrock?.signature || bedrock?.redactedData);
  }
  if (part.type.startsWith("tool-")) {
    return part.state !== "input-streaming";
  }
  return false;
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
 * 1. Frontend stop button → calls POST /stop (sets `chat-stop-<streamId>`) → then calls stop() (closes connection)
 * 2. Connection close fires on the pod running the stream → checks cache → flag found → abort
 * 3. Navigate away → connection close → checks cache → no flag → stream continues in background
 *
 * The stop flag is keyed by `streamId`, so it can only abort the stream it was
 * meant for. Works across pods because the cache is PostgreSQL-backed.
 *
 * Returns a cleanup function to call on normal stream finish: it removes the
 * listeners and clears the distributed cache keys so no stop flag can outlive
 * its stream.
 */
function attachRequestAbortListeners(params: {
  request: { raw: NodeJS.EventEmitter };
  reply: { raw: NodeJS.EventEmitter & { writableEnded: boolean } };
  abortController: AbortController;
  conversationId: string;
  streamId: string;
}): () => void {
  const { request, reply, abortController, conversationId, streamId } = params;
  const stopKey = `${CacheKey.ChatStop}-${streamId}` as const;
  let listenersRemoved = false;

  const removeListeners = () => {
    if (listenersRemoved) {
      return;
    }
    listenersRemoved = true;
    request.raw.removeListener("close", onConnectionClose);
    request.raw.removeListener("aborted", onConnectionClose);
    reply.raw.removeListener("close", onConnectionClose);
  };

  const onConnectionClose = () => {
    removeListeners();
    if (reply.raw.writableEnded || abortController.signal.aborted) {
      return;
    }

    // Check the distributed cache for a stop flag set by the stop endpoint.
    // getAndDelete consumes the flag atomically.
    cacheManager
      .getAndDelete(stopKey)
      .then((stopRequested) => {
        if (stopRequested) {
          logger.info(
            { conversationId, streamId },
            "Chat stop requested, aborting stream execution",
          );
          abortController.abort();
        } else {
          logger.info(
            { conversationId, streamId },
            "Chat connection closed (navigate away), stream continues in background",
          );
        }
      })
      .catch((err) => {
        logger.error(
          { err, conversationId, streamId },
          "Failed to check chat stop flag, not aborting",
        );
      });
  };

  // Called on normal stream finish. Clears this stream's stop flag so it cannot
  // linger. The active-stream key is intentionally left to expire on its own
  // TTL: deleting it here could clobber a newer stream that already replaced
  // the mapping for this conversation.
  const cleanup = () => {
    removeListeners();
    void cacheManager.delete(stopKey);
  };

  request.raw.on("close", onConnectionClose);
  request.raw.on("aborted", onConnectionClose);
  reply.raw.on("close", onConnectionClose);

  return cleanup;
}

async function findReadableConversationById(params: {
  conversationId: string;
  userId: string;
  organizationId: string;
}): Promise<z.infer<typeof SelectConversationSchema> | null> {
  return (
    (await ConversationModel.findAccessibleById({
      id: params.conversationId,
      userId: params.userId,
      organizationId: params.organizationId,
    })) ??
    (await findScheduleRunConversationForAdmin({
      conversationId: params.conversationId,
      userId: params.userId,
      organizationId: params.organizationId,
    }))
  );
}

async function findScheduleRunConversationForAdmin(params: {
  conversationId: string;
  userId: string;
  organizationId: string;
}): Promise<z.infer<typeof SelectConversationSchema> | null> {
  const isScheduledTaskAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "scheduledTask",
    "admin",
  );
  if (!isScheduledTaskAdmin) {
    return null;
  }

  const run = await ScheduleTriggerRunModel.findByChatConversationId(
    params.conversationId,
  );
  if (!run || run.organizationId !== params.organizationId) {
    return null;
  }

  const trigger = await ScheduleTriggerModel.findById(run.triggerId);
  if (!trigger || trigger.organizationId !== params.organizationId) {
    return null;
  }

  return await ConversationModel.findByIdInOrganization({
    id: params.conversationId,
    organizationId: params.organizationId,
  });
}

async function forkConversation(params: {
  sourceConversation: z.infer<typeof SelectConversationSchema>;
  agentId: string;
  userId: string;
  organizationId: string;
}): Promise<z.infer<typeof SelectConversationSchema>> {
  const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  const agent = await AgentModel.findById(
    params.agentId,
    params.userId,
    isAgentAdmin,
  );

  if (!agent) {
    throw new ApiError(404, "Agent not found");
  }

  const newConversation = await ConversationModel.create({
    userId: params.userId,
    organizationId: params.organizationId,
    agentId: agent.id,
    modelId: params.sourceConversation.modelId,
  });

  if (params.sourceConversation.messages.length > 0) {
    // Clone any chat_attachments referenced from source messages so the fork
    // has its own rows scoped to its conversationId — materialize and
    // compaction both filter by conversationId, so without this the fork
    // would silently lose every attached file on the next LLM turn.
    const forkedMessages = await cloneAttachmentsForFork({
      sourceMessages: params.sourceConversation
        .messages as unknown as ChatMessage[],
      sourceConversationId: params.sourceConversation.id,
      newConversationId: newConversation.id,
      newOrganizationId: params.organizationId,
      newUploadedByUserId: params.userId,
    });
    await MessageModel.bulkCreate(
      forkedMessages.map((message) => ({
        conversationId: newConversation.id,
        role: message.role,
        content: message,
      })),
    );
  }

  const result = await ConversationModel.findById({
    id: newConversation.id,
    userId: params.userId,
    organizationId: params.organizationId,
  });

  if (!result) {
    throw new ApiError(500, "Failed to create forked conversation");
  }

  return result;
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
  getMessagesWithChangedContent,
  persistNewMessages,
  prepareMessagesForProvider,
};

export default chatRoutes;
