import { randomUUID } from "node:crypto";
import {
  BUILT_IN_AGENT_IDS,
  CHAT_TITLE_GENERATION_SYSTEM_PROMPT,
  type ChatErrorResponse,
  ChatMessageFeedbackSchema,
  ChatMessageMetadataSchema,
  CONTEXT_WINDOW_BREAKDOWN_EVENT,
  type ContextWindowBreakdown,
  collapseWhitespace,
  getModelReadableMimeTypes,
  isModelSelectionComplete,
  isThinkingEffortSelfHostedProvider,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  RouteId,
  requiresOpenAiResponsesApi,
  requiresPerplexityAgentApi,
  type SupportedProvider,
  TimeInMs,
  type TitleRejectionReason,
  type TokenUsage,
  toConversationTitle,
  toPlaceholderTitle,
  truncateChars,
} from "@archestra/shared";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  generateText,
  type ModelMessage,
  stepCountIs,
  type streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { resolveAgentMaxOutputTokens } from "@/agents/agent-output-budget";
import { MAX_AGENT_STEPS, runAgentStream } from "@/agents/agent-run-stream";
import {
  isOpenAiReasoningSummaryMarkedUnsupported,
  markOpenAiReasoningSummaryUnsupported,
  openAiReasoningSummaryCacheKey,
} from "@/agents/openai-reasoning-summary";
import { hasAnyAgentTypeAdminPermission, userHasPermission } from "@/auth";
import { CacheKey, cacheManager } from "@/cache-manager";
import {
  fetchToolUiResource,
  getChatMcpTools,
  type ToolUiResourceData,
} from "@/clients/chat-mcp-client";
import {
  ChatMcpElicitationResponseSchema,
  createChatMcpElicitationBridge,
  resolveChatMcpElicitation,
} from "@/clients/chat-mcp-elicitation";
import {
  applyMcpTasksToMessages,
  chatTaskPrincipal,
  createChatTaskBridge,
} from "@/clients/chat-task-bridge";
import {
  applyDualLlmAnalysesToMessages,
  createDualLlmAnalysisStreamBridge,
} from "@/clients/dual-llm-analysis-stream";
import {
  createLLMModel,
  createLLMModelForAgent,
  isApiKeyRequired,
} from "@/clients/llm-client";
import {
  applySubagentToolCallsToMessages,
  createSubagentToolStreamBridge,
} from "@/clients/subagent-tool-stream";
import {
  recordUnavailableToolCallStep,
  repeatCeilingStopCondition,
  type ToolCallRepeatTracker,
} from "@/clients/tool-call-repeat-tracker";
import config from "@/config";
import type { LockedChatAuditContext } from "@/content-encryption/locked-chat";
import db, { withDbTransaction } from "@/database";
import { browserStreamFeature } from "@/features/browser-stream/services/browser-stream.feature";
import { dualLlmProgressBus } from "@/guardrails/dual-llm-progress-bus";
import { hookDispatcherService } from "@/hooks/hook-dispatcher-service";
import {
  applyHookRunsToMessages,
  type CollectedHookRun,
  stripHookRunParts,
  toCollectedRuns,
} from "@/hooks/hook-run-parts";
import {
  type KbChunkForQuoteCheck,
  verifyQuotes,
} from "@/knowledge-base/quote-verification";
import logger from "@/logging";
import {
  ActiveChatRunModel,
  AgentModel,
  AgentTeamModel,
  ConversationAttachmentModel,
  ConversationChatErrorModel,
  ConversationEnabledToolModel,
  ConversationModel,
  ConversationShareModel,
  LlmProviderApiKeyModel,
  McpGatewayTaskModel,
  MemberModel,
  MessageModel,
  ModelModel,
  OrganizationModel,
  ProjectModel,
  ProjectShareModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  TeamModel,
} from "@/models";
import { toConversationApiMessages } from "@/models/conversation";
import { reportChatMessageFeedback } from "@/observability/metrics/chat";
import { reportQuoteVerification } from "@/observability/metrics/rag";
import { startActiveChatSpan } from "@/observability/tracing";
import { mcpGatewayTaskRunner } from "@/routes/mcp-gateway/tasks";
import {
  ACTIVE_CHAT_RUN_TERMINAL_REPLAY_GRACE_MS,
  activeChatRunService,
} from "@/services/active-chat-run";
import { assertCallerMayStartTurn } from "@/services/agent-credential-readiness";
import {
  type OpenedApp,
  resolveOpenedApp,
} from "@/services/apps/opened-app-context";
import { conversationFilesService } from "@/services/conversation-files";
import { projectService } from "@/services/project";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import { fileStore } from "@/skills-sandbox/file-store";
import { resolveProjectFileScope } from "@/skills-sandbox/project-file-scope";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { renderSystemPrompt } from "@/templating";
import type { ConversationContentKey } from "@/types";
import {
  ApiError,
  type ChatMessage,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ErrorResponsesSchema,
  InsertConversationSchema,
  SelectConversationCompactionSchema,
  SelectConversationSchema,
  SelectConversationShareWithTargetsSchema,
  ThinkingEffortSchema,
  type UpdateConversation,
  UpdateConversationSchema,
  UuidIdSchema,
} from "@/types";
import { ConversationFilesResponseSchema } from "@/types/conversation-file";
import {
  resolveAgentLlmOrDefault,
  resolveConversationLlmSelectionForAgent,
  resolveConversationModel,
} from "@/utils/llm-resolution";
import { estimateMessagesSize } from "@/utils/message-size";
import { broadcastConversationUpdated } from "@/websocket";
import { createAbortiveTurnTracker } from "./abortive-turn";
import { buildAnthropicProviderOptions } from "./anthropic-provider-options";
import {
  isSafeInlineMimeType,
  sanitizeAttachmentContentType,
} from "./attachment-content-type";
import { buildChatContext } from "./build-chat-context";
import {
  compactMessagesForChat,
  invalidateConversationCompactions,
} from "./context-compaction";
import {
  buildContextWindowBreakdown,
  refreshBreakdownUsedTokens,
  resolveInputPricePerToken,
} from "./context-window-breakdown";
import {
  buildAbortiveTurnError,
  formatUnavailableToolErrorDetails,
  getActiveTraceContext,
  getUnavailableToolErrorDetails,
  mapProviderError,
  ProviderError,
  sanitizeChatErrorForFrontend,
} from "./errors";
import { buildGeminiProviderOptions } from "./gemini-provider-options";
import { injectAppDiagnostics } from "./inject-app-diagnostics";
import {
  injectExternalMcpSkillActivation,
  injectPluginSkillActivation,
  injectSkillActivation,
} from "./inject-skill-activation";
import {
  LOCKED_CHAT_STATIC_TITLE,
  requireLockedChatKey,
  resolveLockedChatAccess,
  resolveLockedChatCreation,
} from "./locked-chat";
import { cloneAttachmentsForFork } from "./normalization/clone-attachments-for-fork";
import { assertWithinContextWindow } from "./normalization/enforce-context-window-limit";
import {
  assertInlineAttachmentsAcceptable,
  extractInlineAttachments,
  messagesHaveNewInlineAttachments,
} from "./normalization/extract-inline-attachments";
import {
  normalizeChatMessages,
  normalizeChatMessagesForPersistence,
} from "./normalization/normalize-chat-messages";
import { buildOllamaNativeProviderOptions } from "./ollama-native-params";
import { buildOpenAiThinkingProviderOptions } from "./openai-provider-options";
import { buildModelMessages } from "./prepare-model-messages";
import { readOpenedAppRef } from "./read-opened-app-ref";
import {
  detectSandboxCommand,
  runSandboxCommandTurn,
} from "./sandbox-command-turn";
import { createToolCallRepair } from "./tool-call-repair";
import { createToolUiStartTransform } from "./tool-ui-stream";
import { sendGatedUiMessageStreamResponse } from "./ui-stream-response";

// The chat route always builds a `messages` (not `prompt`) config, so the
// `runAgentStream` config is narrowed to require it.
type ChatStreamTextConfig = Parameters<typeof streamText>[0] & {
  messages: ModelMessage[];
};

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

/**
 * Build the error JSON payload streamed to the frontend: attach trace
 * correlation ids, apply the org's slim-error setting, persist the error on
 * the conversation, and serialize defensively (mapProviderError already
 * serializes raw errors safely, the fallback guards the rest).
 */
function buildStreamErrorPayload(params: {
  error: unknown;
  mappedError: ChatErrorResponse;
  conversationId: string;
  slimChatErrorUi: boolean;
  /**
   * Locked chat: provider error text routinely echoes prompt/model
   * content, so the persisted row must not hold it in the clear. With an
   * `lockedChatAudit` it is encrypted under the conversation key; without one
   * the row keeps only the code and retryability with a generic message. The
   * payload streamed to the client is unaffected (it is not persisted).
   */
  redactPersistedError: boolean;
  lockedChatAudit?: LockedChatAuditContext | null;
  /** Log label distinguishing the pre-stream and mid-stream error paths. */
  stage: "before stream starts" | "via stream";
}): string {
  const {
    error,
    mappedError,
    conversationId,
    slimChatErrorUi,
    redactPersistedError,
    lockedChatAudit,
    stage,
  } = params;
  const traceContext = getActiveTraceContext();
  const correlationLogFields = getCorrelationLogFields(traceContext);
  const fullError = { ...mappedError, ...traceContext };
  const errorForFrontend = slimChatErrorUi
    ? sanitizeChatErrorForFrontend(fullError)
    : fullError;

  let serialized: string;
  try {
    serialized = JSON.stringify(errorForFrontend);
  } catch (stringifyError) {
    logger.error(
      {
        stringifyError,
        errorCode: mappedError.code,
        ...correlationLogFields,
      },
      "Failed to stringify mapped error, returning minimal error",
    );
    serialized = JSON.stringify(getMinimalFrontendError(errorForFrontend));
  }

  persistConversationChatError({
    conversationId,
    error:
      redactPersistedError && !lockedChatAudit
        ? redactChatErrorForLockedChat(errorForFrontend)
        : errorForFrontend,
    lockedChatAudit,
  });

  logger.info(
    {
      mappedError: fullError,
      originalErrorType: error instanceof Error ? error.name : typeof error,
      willBeSentToFrontend: true,
      ...correlationLogFields,
    },
    `Returning mapped error to frontend ${stage}`,
  );

  return serialized;
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
          // Optional sampling override; when omitted the provider/model default applies (unchanged
          // behavior). The benchmark harness sets this to pin runs against temperature variance.
          temperature: z.number().min(0).max(2).optional(),
          // The depth the composer is showing for this turn. Sent with the
          // message so the turn cannot run at a depth the user has replaced but
          // whose PATCH has not landed yet; the stored column is the fallback
          // for callers that don't send one.
          thinkingEffort: ThinkingEffortSchema.nullable().optional(),
        }),
        // Streaming responses don't have a schema
        response: ErrorResponsesSchema,
      },
    },
    async (request, reply) => {
      const {
        body: {
          id: conversationId,
          messages,
          trigger,
          temperature,
          thinkingEffort: requestedThinkingEffort,
        },
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
      const claimMessagesPersisted = (): boolean => {
        if (messagesPersisted || !conversationId) {
          return false;
        }
        messagesPersisted = true;
        return true;
      };

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

      // A shared agent may be configured to refuse callers who cannot reach one
      // of the MCP servers its tools come from, rather than letting them find
      // out mid-turn when such a tool errors. The picker greys these agents out,
      // but that is advisory — this is the authoritative check, and it runs
      // before anything is persisted or streamed. Agents left on the default
      // `allow` behavior short-circuit inside the service with no extra queries.
      await assertCallerMayStartTurn({
        agentId: conversation.agentId,
        userId: user.id,
      });

      // LockedChat: the browser-held key is required up front (fingerprint
      // checked, wrong key 409s before any side effect) and captured ONCE
      // into this request's closure — every persistence call below receives
      // it explicitly, including the detached onFinish/onError callbacks that
      // outlive the client connection.
      const lockedChatKeyInfo = conversation.lockedChat
        ? ((await ConversationModel.getLockedChatKeyInfo(conversationId)) ?? {
            id: conversationId,
            lockedChat: true,
            lockedChatDekFingerprint: null,
            hasEscrow: false,
          })
        : null;
      const lockedChatKey: ConversationContentKey | null = lockedChatKeyInfo
        ? requireLockedChatKey({ request, conversation: lockedChatKeyInfo })
        : null;
      // Encrypting the audit trail is only worth doing when an escrow record
      // exists to open it later — otherwise the rows would be readable by
      // nobody, which is strictly worse than an honest, uniform gap. Without
      // one these surfaces deliberately fall back to redaction.
      const lockedChatAudit: LockedChatAuditContext | null =
        lockedChatKey && lockedChatKeyInfo?.hasEscrow ? lockedChatKey : null;
      // Gate uploaded attachments before any bytes are persisted: anything
      // within the attachment storage cap is accepted — a file the model can't
      // ingest, or one too big for the sandbox, still lands in the
      // conversation's Files panel (and is staged into the sandbox when one is
      // available and the file fits it). The frontend mirrors this for UX, but
      // a custom client bypasses it, so this is the authoritative check. Runs
      // before extractInlineAttachments and before the active run is acquired,
      // so a rejected request stores nothing. Skipped (with its model/sandbox
      // lookups) on the common turn that uploads nothing.
      if (messagesHaveNewInlineAttachments(messages as ChatMessage[])) {
        const attachmentModelRow = conversation.modelId
          ? await ModelModel.findById(conversation.modelId)
          : null;
        assertInlineAttachmentsAcceptable({
          messages: messages as ChatMessage[],
          policy: {
            ingestibleMimeTypes: getModelReadableMimeTypes(
              attachmentModelRow?.inputModalities ?? null,
            ),
            sandboxAvailable: await isSkillSandboxAvailableForAgent({
              userId: user.id,
              organizationId,
              agentId: conversation.agentId,
            }),
            sandboxByteLimit: config.skillsSandbox.artifactBytesLimit,
            fileStorageByteLimit: config.chat.attachmentStorageBytesLimit,
          },
        });
      }

      // Lifecycle hooks (SessionStart). Cheap no-op when the agent has no hooks or
      // the sandbox is disabled. Fired before createRun. Every fire is wrapped in
      // try/catch and fails open — hooks must never break chat.
      // Context returned by hooks is appended to the system prompt below.
      let hookSessionContext: string | undefined;
      // Inline hook-run debug entries collected across this turn (SessionStart at
      // the top, Pre/PostToolUse around their tool calls, Stop at the end) and
      // spliced into the assistant message in onFinish.
      const hookRunCollector: CollectedHookRun[] = [];
      // Verifiable citations (issue #7161): the chunks query_knowledge_sources
      // returns this turn, captured at tool-execution time (run_tool dispatches
      // included) and checked against the answer's cited quotes in the UI
      // stream's onFinish. Absent when the feature is off — the tool layer then
      // neither asks the model to quote nor captures anything.
      const kbChunksCollector: KbChunkForQuoteCheck[] | undefined = config.kb
        .quoteVerificationEnabled
        ? []
        : undefined;
      // Surfaces a delegated child agent's tool calls on this conversation: it
      // streams each one live (once a writer is attached) and collects them for
      // splicing into the assistant message in onFinish. One instance is shared
      // down the whole delegation chain.
      const subagentToolStream = createSubagentToolStreamBridge();
      // Surfaces the proxy's dual LLM sanitization work on this conversation as
      // structured analysis parts. The proxy publishes events on the in-process
      // bus under a per-turn channel id that rides the loopback request as a
      // header; the bridge streams them live and collects them for splicing in
      // onFinish, buffering anything that fires before the model stream's
      // `start` chunk (a pre-`start` data part mints a phantom message).
      const dualLlmAnalysisStream = createDualLlmAnalysisStreamBridge();
      const dualLlmProgressChannel = randomUUID();
      const unsubscribeDualLlmProgress = dualLlmProgressBus.subscribe(
        dualLlmProgressChannel,
        (event) => dualLlmAnalysisStream.handleEvent(event),
      );
      // Detaches a tool call that outlives the synchronous threshold into a
      // durable task, so the user sees a live cancellable card instead of the
      // turn simply failing at the timeout.
      const chatTaskBridge = createChatTaskBridge();
      // The conversation's user id (the sandbox is keyed per org/user/conversation).
      const conversationUserId = conversation.userId;

      // First turn = no prior assistant turn exists in the incoming thread.
      // True for a brand-new conversation; false once the model has replied.
      const isFirstTurn = !(messages as ChatMessage[]).some(
        (message) => message?.role === "assistant",
      );

      if (isFirstTurn) {
        try {
          // Resolve the model id for the SessionStart payload. Dereferences the
          // conversation's model_id FK (env/config fallback if unset).
          const { model: sessionStartModel } = await resolveConversationModel(
            conversation.modelId,
          );
          const result = await hookDispatcherService.fire({
            event: "session_start",
            conversationId,
            agentId: conversation.agentId,
            organizationId,
            userId: conversationUserId,
            fields: { source: "startup", model: sessionStartModel },
          });
          // SessionStart cannot block; only its injected context is used.
          hookSessionContext = result.injectedContext;
          hookRunCollector.push(
            ...toCollectedRuns(result.runs, { kind: "turn-start" }),
          );
        } catch (error) {
          logger.warn(
            { error, conversationId },
            "SessionStart hook dispatch failed, proceeding",
          );
        }
      }

      const activeRun = await activeChatRunService.createRun({
        conversationId,
        userId: user.id,
        organizationId,
      });

      if (!activeRun) {
        if (activeChatRunService.shuttingDown) {
          throw new ApiError(
            503,
            "The server is shutting down. Please retry in a moment.",
          );
        }
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
      // Detected before extraction rewrites data: URLs into refs.
      const turnHasNewAttachments = (messages as ChatMessage[]).some(
        (message) =>
          message.parts?.some(
            (part) =>
              part.type === "file" &&
              typeof part.url === "string" &&
              part.url.startsWith("data:"),
          ),
      );
      try {
        await extractInlineAttachments({
          messages: messages as ChatMessage[],
          conversationId,
          organizationId,
          uploadedByUserId: user.id,
          // Seals the bytes, filename and extracted text of a locked chat's
          // uploads. `requireLockedChatKey` above already failed the turn if
          // this chat is locked and the request carried no key, so a locked
          // conversation never reaches here with null.
          conversationKey: lockedChatKey,
        });
      } catch (error) {
        await activeChatRunService.markTerminal({
          runId: activeRun.id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // A locked chat's uploads are never staged into the sandbox: staging
      // writes the opened bytes into the sandbox replay log
      // (`skill_sandbox_files`), which is stored in plaintext and outside the
      // conversation key — the one copy of the file that a database dump could
      // read. They stay in the (sealed) attachment row and travel to the model
      // inline, which is exactly the path the locked-chat guarantee covers.
      if (turnHasNewAttachments && !conversation.lockedChat) {
        // Upload-time staging: a file the model can't take must already be on
        // the sandbox filesystem when the pointer notice reaches the model,
        // not parked until the first sandbox op. Fire-and-forget — op-time
        // staging remains the idempotent catch-up, so a failure costs nothing.
        void isSkillSandboxAvailableForAgent({
          userId: user.id,
          organizationId,
          agentId: conversation.agentId,
        })
          .then((available) =>
            available
              ? skillSandboxRuntimeService.stageConversationAttachmentsNow({
                  organizationId,
                  userId: conversationUserId,
                  conversationId,
                })
              : undefined,
          )
          .catch((error) => {
            logger.warn(
              { error, conversationId },
              "upload-time attachment staging failed",
            );
          });
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

        // A `!`-prefixed sandbox command turn: execute run_command directly
        // and stream/persist the result as a normal tool part — no LLM call,
        // so none of the context/tool building below runs. Re-sending a
        // transcript that ends at a stored `!` message re-executes it — the
        // same "sending a turn runs it" semantics regenerate relies on.
        const sandboxCommand = detectSandboxCommand(messages as ChatMessage[]);
        if (sandboxCommand && conversation.lockedChat) {
          // Sandbox command turns persist command I/O into the sandbox replay
          // log in plaintext — not offered in locked chats.
          throw new ApiError(
            400,
            "Sandbox commands are not available in locked chats",
          );
        }
        if (sandboxCommand) {
          // Persist the user message before execution (mirrors the LLM path's
          // early persist): the command lands in the sandbox replay log the
          // moment it runs, so the transcript must already show it even if
          // final persistence fails or the process dies mid-turn.
          try {
            await persistNewMessages(conversationId, messages, "earlyUserMsg");
          } catch (error) {
            logger.warn(
              { error, conversationId },
              "Failed to persist user messages early (will retry in onFinish)",
            );
          }
          const sandboxSlimChatErrorUi =
            await OrganizationModel.getSlimChatErrorUi(organizationId);
          return await runSandboxCommandTurn({
            command: sandboxCommand.command,
            messages: messages as ChatMessage[],
            conversationId,
            agent: { id: agentId, name: agent.name },
            userId: user.id,
            organizationId,
            activeRunId: activeRun.id,
            abortController: chatAbortController,
            reply,
            persistTurn: async (finalMessages) => {
              // SessionStart hook runs (fired above on the first turn) are
              // spliced into the assistant message exactly like the LLM path,
              // so hook activity stays visible on a `!` first turn.
              const messagesToPersist = applyHookRunsToMessages(
                finalMessages,
                hookRunCollector,
              );
              if (trigger === "regenerate-message") {
                await persistRegeneratedTurn({
                  conversationId,
                  requestMessages: messages,
                  finalMessages: messagesToPersist,
                  conversationKey: lockedChatKey,
                });
              } else {
                await persistNewMessages(
                  conversationId,
                  messagesToPersist,
                  "onFinish",
                  lockedChatKey,
                );
              }
            },
            onStreamSettled: () => {
              removeAbortListeners();
              stopActiveRunPolling();
              unsubscribeDualLlmProgress();
            },
            buildErrorPayload: ({ error, mappedError }) =>
              buildStreamErrorPayload({
                error,
                mappedError,
                conversationId,
                slimChatErrorUi: sandboxSlimChatErrorUi,
                redactPersistedError: conversation.lockedChat,
                lockedChatAudit,
                stage: "via stream",
              }),
          });
        }

        const externalAgentId = agentId;
        const chatMcpElicitation = createChatMcpElicitationBridge({
          conversationId,
          abortSignal: chatAbortController.signal,
        });

        // A project chat prepends the project's instructions to the system
        // prompt. Kicked off as a promise so it runs concurrently with the org
        // reads below rather than adding a serial read on the hot path.
        // Best-effort: a read failure (or lost project access) must never break
        // the chat, and an empty file injects nothing. The injected length is
        // clamped: the editor caps saves at the same limit, but the file is
        // also writable by the agent tools (bounded only by the much larger
        // artifact byte limit), and this content goes into every turn's prompt.
        const projectInstructionsPromise: Promise<string | undefined> =
          conversation.projectId
            ? projectService
                .getInstructions({
                  id: conversation.projectId,
                  organizationId,
                  userId: user.id,
                })
                .then(({ content }) =>
                  content.trim()
                    ? content.slice(0, PROJECT_INSTRUCTIONS_MAX_LENGTH)
                    : undefined,
                )
                .catch((error) => {
                  logger.warn(
                    {
                      error,
                      conversationId,
                      projectId: conversation.projectId,
                    },
                    "Failed to load project instructions, proceeding without them",
                  );
                  return undefined;
                })
            : Promise.resolve(undefined);

        // When an app is open in the chat, the client reports it on the turn's
        // last user message; we restate that app in the system prompt so the
        // model keeps treating the conversation as being about it. The client
        // hint is untrusted — `resolveOpenedApp` re-runs the caller's access
        // check, so a forged id only surfaces an app they could already see.
        // Same posture as the project instructions above: concurrent, and
        // best-effort — a resolve failure (or an app since deleted or made
        // inaccessible) drops the injection rather than breaking the chat.
        const openedAppRef = readOpenedAppRef(messages as ChatMessage[]);
        const openedAppPromise: Promise<OpenedApp | undefined> = openedAppRef
          ? resolveOpenedApp({
              openedApp: openedAppRef,
              userId: user.id,
              organizationId,
              ...(conversationId ? { sessionKey: conversationId } : {}),
            }).catch((error) => {
              logger.warn(
                { error, conversationId },
                "Failed to load the chat's open app, proceeding without its context",
              );
              return undefined;
            })
          : Promise.resolve(undefined);

        // A project chat also lists the project's shared files in the system
        // prompt: they are attached to the project rather than to any message,
        // so nothing else ever tells the model they exist, and it answers "you
        // haven't attached any files" to a user who is looking at them in the
        // Files panel. Same posture as the project instructions above:
        // concurrent, best-effort (a failure injects nothing), and gated by the
        // same fail-closed project-access check the file tools use.
        const projectFileNamesPromise: Promise<string[] | undefined> =
          conversation.projectId
            ? resolveProjectFileScope({
                conversationId,
                userId: user.id,
                organizationId,
              })
                .then((scope) =>
                  scope
                    ? fileStore
                        .search({
                          organizationId,
                          userId: user.id,
                          scope: { kind: "project", ...scope },
                        })
                        .then((files) => files.map((file) => file.filename))
                    : undefined,
                )
                .catch((error) => {
                  logger.warn(
                    {
                      error,
                      conversationId,
                      projectId: conversation.projectId,
                    },
                    "Failed to list project files, proceeding without them",
                  );
                  return undefined;
                })
            : Promise.resolve(undefined);

        // Resolve once and share the same row between tool-output media gating
        // and the LLM call. The promise runs beside the other turn setup reads.
        const conversationModelPromise = resolveConversationModel(
          conversation.modelId,
        );

        // Tools + system prompt, alongside the org settings the stream needs.
        const [
          {
            mcpTools,
            toolUiResourceUris,
            systemPrompt,
            toolSelection,
            repeatTracker,
          },
          slimChatErrorUi,
          organization,
          { model: selectedModel, provider },
        ] = await Promise.all([
          Promise.all([
            projectInstructionsPromise,
            openedAppPromise,
            projectFileNamesPromise,
            conversationModelPromise,
          ]).then(
            ([projectInstructions, openedApp, projectFileNames, selected]) =>
              buildChatContext({
                conversationId,
                agentId,
                // The conversation came from findById, which selects the agent's
                // prompt (only list reads omit it) — pin the optional field to
                // the concrete `string | null` contract the builder declares.
                agent: { ...agent, systemPrompt: agent.systemPrompt ?? null },
                user: { id: user.id, email: user.email, name: user.name },
                organizationId,
                modelAcceptsImageToolResults:
                  selected.inputModalities?.includes("image") === true,
                hookSessionContext,
                projectInstructions,
                openedApp,
                projectFileNames,
                hookRunCollector,
                kbChunksCollector,
                elicitation: chatMcpElicitation,
                subagentToolStream,
                taskBridge: chatTaskBridge,
                abortSignal: chatAbortController.signal,
                // LockedChat: span content is suppressed and long calls never
                // detach into durable tasks; tool-call logs and claim results
                // are encrypted under the conversation key when it can be
                // recovered from escrow, redacted otherwise.
                suppressContentLogging: conversation.lockedChat,
                lockedChatAudit,
              }),
          ),
          OrganizationModel.getSlimChatErrorUi(organizationId),
          OrganizationModel.getById(organizationId),
          conversationModelPromise,
        ]);

        logger.info(
          {
            conversationId,
            agentId,
            userId: user.id,
            orgId: organizationId,
            toolCount: Object.keys(mcpTools).length,
            hasCustomToolSelection: toolSelection.hasCustomSelection,
            enabledToolCount: toolSelection.hasCustomSelection
              ? toolSelection.enabledToolCount
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
          teams: await AgentTeamModel.getTeamLabelInfoForAgent(agentId),
          userTeams: await TeamModel.getTeamLabelInfoForUser({
            userId: user.id,
            organizationId,
          }),
          user: { id: user.id, email: user.email, name: user.name },
          callback: async () => {
            // Build the model-bound copy of the history: slash-command skill
            // injection (requires the org's skill tools — the injected block
            // references load_skill) followed by normalization. The original
            // `messages` stay clean for persistence and the visible bubble.
            const skillSlashCommandsActive = !!organization?.skillToolsEnabled;
            const messagesWithSkill = skillSlashCommandsActive
              ? await injectSkillActivation({
                  messages: messages as ChatMessage[],
                  organizationId,
                  userId: user.id,
                  agentId: conversation.agentId ?? undefined,
                  conversationId,
                  provider,
                  model: selectedModel,
                })
              : (messages as ChatMessage[]);
            const messagesWithExternalSkill =
              await injectExternalMcpSkillActivation({
                messages: messagesWithSkill,
                organizationId,
                userId: user.id,
                agentId: conversation.agentId ?? undefined,
                conversationId,
                provider,
                model: selectedModel,
              });
            const messagesWithPluginSkill = await injectPluginSkillActivation({
              messages: messagesWithExternalSkill,
              organizationId,
              userId: user.id,
              conversationId,
              provider,
              model: selectedModel,
            });

            // Render-loop diagnostics from owned MCP App renders ride the last
            // user message's metadata; inject them (delimited, framed as
            // untrusted) so the model can fix the app via edit_app. No-op
            // when absent or when the apps feature is off.
            const messagesForLLM = await injectAppDiagnostics(
              messagesWithPluginSkill,
            );

            // Normalize chat history before replaying it to the model.
            // This dedupes repeated tool parts, drops dangling interrupted tool calls,
            // and strips heavy image/browser payloads that would otherwise bloat context.
            const normalizedMessagesForLLM =
              normalizeChatMessages(messagesForLLM);

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
                lockedChatKey,
              );
            } catch (error) {
              logger.warn(
                { error, conversationId },
                "Failed to persist user messages early (will retry in onFinish)",
              );
            }

            // Cleared on every execute() exit path: the normal completion below
            // and the top-level onError (which fires when execute throws, e.g.
            // a non-context-length error during the context-trim probe).
            let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

            // Create stream with token usage data support
            const uiMessageStream = createUIMessageStream({
              // Preserve incoming message IDs so the client updates existing
              // assistant messages instead of rendering duplicate ones.
              originalMessages: messages as UIMessage[],
              onError: (error) => {
                if (heartbeatInterval) clearInterval(heartbeatInterval);
                // unlike the tool-level stream handler, a NoSuchToolError here
                // is not a recoverable tool result: it must mark the run failed
                // and persist, so it falls through to the normal error path.
                activeRunError =
                  error instanceof Error ? error.message : String(error);
                // Persist messages on stream-level errors (e.g. errors thrown
                // in execute before writer.merge() is reached). Without this,
                // user messages are lost on refresh after an error.
                const shouldPersist = claimMessagesPersisted();
                (async () => {
                  if (shouldPersist) {
                    try {
                      await persistNewMessages(
                        conversationId,
                        messages,
                        "onStreamError",
                        lockedChatKey,
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

                return buildStreamErrorPayload({
                  error,
                  mappedError: mapProviderError(error, provider),
                  conversationId,
                  slimChatErrorUi,
                  redactPersistedError: conversation.lockedChat,
                  lockedChatAudit,
                  stage: "before stream starts",
                });
              },
              execute: async ({ writer }) => {
                chatMcpElicitation.setWriter(writer);
                subagentToolStream.setWriter(writer);
                chatTaskBridge.setWriter(writer);
                dualLlmAnalysisStream.setWriter(writer);

                // Create the LLM model here, inside execute, so a credential
                // failure (e.g. a per-user provider like GitHub Copilot the user
                // hasn't connected) flows through onError → mapProviderError and
                // reaches the client as a structured ProviderAuthRequired error
                // (the inline connect card) rather than a generic server error.
                // Pass agent's llmApiKeyId so it's used without a user access
                // check; pass conversationId as sessionId to group the session.
                const { model, anthropicNativeEndpoint, chatApiKeyId } =
                  await createLLMModelForAgent({
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
                    dualLlmProgressChannel,
                    // Lets the proxy store this turn's interaction encrypted
                    // rather than redacted. Only sent when an escrow record
                    // exists, since without one the row could never be reopened.
                    lockedChatKey: lockedChatAudit?.dek ?? null,
                  });

                // Send heartbeat every 5s to prevent connection drops
                // during long-running tool executions / subagent calls.
                heartbeatInterval = setInterval(() => {
                  try {
                    writer.write({
                      type: "data-heartbeat",
                      data: { timestamp: Date.now() },
                      transient: true,
                    });
                  } catch {
                    clearInterval(heartbeatInterval);
                  }
                }, 5000);

                // Prefetch all UI resources eagerly before streaming starts so
                // the merge transform below can emit data-tool-ui-start
                // synchronously right after each tool-input-start chunk. A
                // .then() on a resolved promise runs as a microtask — the stream
                // would process more chunks before it fires, landing
                // data-tool-ui-start after all tool deltas instead of right
                // after tool-input-start.
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

                // Loaded once and reused for both message assembly (to know
                // which attachment types this model can read) and the context
                // window breakdown below. A failed lookup is non-fatal.
                const modelRow = await ModelModel.findByProviderAndModelId(
                  provider,
                  selectedModel,
                ).catch((error) => {
                  logger.warn(
                    { error, conversationId },
                    "[chat] failed to load model row for the turn",
                  );
                  return null;
                });

                // Omit tools for models that can't take them (e.g. Microsoft
                // 365 Copilot) instead of letting the provider reject the
                // turn; an unknown capability is assumed supported. Decided
                // per model, never per provider: a provider-wide gate hides a
                // tool-capable model behind its siblings, and it disagrees
                // with the composer's "no tools" chip, which reads this same
                // capability. Providers whose endpoint takes no tools record
                // it as `supportsToolCalling: false` on the model row — see
                // inferPerplexityCapabilities in services/model-sync.ts for
                // why every `sonar*` row carries that flag.
                const supportsToolCalling =
                  modelRow?.supportsToolCalling !== false;

                const { modelMessages, preparedMessages } =
                  await buildModelMessages({
                    messages: normalizedMessagesForLLM,
                    conversationId,
                    organizationId,
                    userId: user.id,
                    agentId: conversation.agentId,
                    provider,
                    selectedModel,
                    modelId: conversation.modelId,
                    inputModalities: modelRow?.inputModalities ?? null,
                    agentLlmApiKeyId: agent.llmApiKeyId,
                    systemPrompt,
                    abortSignal: chatAbortController.signal,
                    emit: (event) => writer.write(event),
                    // LockedChat: never generate/persist a compaction summary.
                    disableCompaction: conversation.lockedChat,
                    anthropicNativeEndpoint,
                    // Opens this chat's sealed attachment rows so their bytes
                    // can be inlined for the provider.
                    conversationKey: lockedChatKey,
                  });

                // Per-category breakdown of the assembled request, powering
                // the Context Window Visualizer. Built from the provider-prepared,
                // parts-bearing messages (inlineable text docs already rewritten
                // to text) — the converted `modelMessages` carry no `.parts`, so
                // the breakdown would otherwise count only the system prompt and
                // tools.
                //
                // After tool-call steps we re-emit an updated breakdown using the
                // provider's exact inputTokens so the visualizer headline stays
                // accurate across multi-step turns. The category estimates stay
                // proportional to the initial build; the ring and totals track
                // the real prompt size.
                let latestBreakdown: ContextWindowBreakdown | null = null;
                let breakdownPricePerToken: number | null = null;
                try {
                  breakdownPricePerToken = resolveInputPricePerToken(modelRow);
                  const breakdown = buildContextWindowBreakdown({
                    provider,
                    model: selectedModel,
                    contextLength: modelRow
                      ? ModelModel.resolveEffectiveContextLength(modelRow)
                      : null,
                    inputPricePerToken: breakdownPricePerToken,
                    systemPrompt,
                    tools: supportsToolCalling ? mcpTools : undefined,
                    messages: preparedMessages,
                  });
                  latestBreakdown = breakdown;
                  // Transient: this fires before the model stream's `start`
                  // chunk, and a non-transient pre-start data part makes the
                  // client mint a phantom assistant message per attach (see
                  // prepare-model-messages.ts). Consumed via onData state.
                  writer.write({
                    type: CONTEXT_WINDOW_BREAKDOWN_EVENT,
                    data: breakdown,
                    transient: true,
                  });
                } catch (error) {
                  // The visualizer is non-essential; never let it break a chat turn.
                  logger.warn(
                    { error, conversationId },
                    "[ContextWindow] failed to build context window breakdown",
                  );
                }

                // Reject a prompt that cannot fit the model's context window
                // before the provider call, so the user gets an actionable
                // "too long" message instead of a generic provider rejection.
                // Reuses the breakdown's budget (gating on the tokenizer-counted
                // categories only). Skipped when the budget could not be built —
                // the provider remains the safety net in that case.
                if (latestBreakdown !== null) {
                  assertWithinContextWindow(latestBreakdown);
                }

                // Flipped once runAgentStream returns the committed result. The
                // probe drains discarded retry attempts before this, so their
                // onStepFinish callbacks must not emit usage events.
                let hasCommittedResult = false;

                // The committed turn's last step finishReason, captured for the
                // abortive-turn tracker (which taps the UI stream and can't see
                // it) so a `length`-truncated tool call surfaces the
                // non-retryable ToolCallOutputTruncated error, not a futile
                // "retrying may help".
                let lastFinishReason: string | null = null;

                const streamTextConfig: ChatStreamTextConfig = {
                  model,
                  messages: modelMessages,
                  ...(supportsToolCalling && { tools: mcpTools }),
                  stopWhen: buildChatStopConditions(repeatTracker),
                  abortSignal: chatAbortController.signal,
                  experimental_repairToolCall: createToolCallRepair({
                    toolNames: Object.keys(mcpTools),
                    abortSignal: chatAbortController.signal,
                    logContext: { conversationId },
                    // A separate model instance so the re-ask is logged under
                    // its own interaction source: it carries no agent context
                    // (no system prompt), and consumers of the session's
                    // interactions (logs UI, benchmarks) must be able to tell
                    // it apart from the main turn.
                    createRepairModel: async () =>
                      (
                        await createLLMModelForAgent({
                          organizationId,
                          userId: user.id,
                          agentId,
                          model: selectedModel,
                          provider,
                          conversationId,
                          externalAgentId,
                          sessionId: conversationId,
                          source: "chat:tool_call_repair",
                          agentLlmApiKeyId: agent.llmApiKeyId,
                          // A repair prompt carries the same conversation
                          // content as the turn it repairs.
                          lockedChatKey: lockedChatAudit?.dek ?? null,
                        })
                      ).model,
                  }),
                  // Emit per-step usage so the context indicator tracks the
                  // prompt growing across tool round-trips, instead of jumping
                  // only once when the whole turn finishes. Suppressed for
                  // discarded retry attempts (empty/abortive) that the probe
                  // drains before a result is committed, so their usage never
                  // reaches the client.
                  onStepFinish: (step) => {
                    const { usage, finishReason } = step;
                    if (!hasCommittedResult) {
                      return;
                    }
                    // Feeds the repeat ceiling in stopWhen the one call shape it
                    // cannot otherwise see: a tool outside the tool list never
                    // reaches an execute wrapper, so nothing fingerprints it.
                    recordUnavailableToolCallStep(repeatTracker, step);
                    // Fires for the truncated step before the tracker's flush,
                    // so this holds the finishReason the tracker keys off.
                    lastFinishReason = finishReason;
                    writer.write({
                      type: "data-token-usage",
                      data: {
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        totalTokens: usage.totalTokens,
                        cacheReadTokens: usage.cachedInputTokens,
                      } satisfies TokenUsage,
                    });

                    // After a tool-call step the next model call will receive a
                    // larger prompt (tool results appended). Re-emit the breakdown
                    // with the provider's exact input-token count so the panel
                    // headline stays accurate between steps. Category proportions
                    // are kept from the initial estimate — they are still the best
                    // available approximation of where tokens went.
                    if (
                      finishReason === "tool-calls" &&
                      latestBreakdown !== null &&
                      usage.inputTokens != null &&
                      usage.inputTokens > 0
                    ) {
                      try {
                        const inputTokens = usage.inputTokens;
                        const updatedBreakdown = refreshBreakdownUsedTokens(
                          latestBreakdown,
                          inputTokens,
                          breakdownPricePerToken,
                        );
                        latestBreakdown = updatedBreakdown;
                        writer.write({
                          type: CONTEXT_WINDOW_BREAKDOWN_EVENT,
                          data: updatedBreakdown satisfies ContextWindowBreakdown,
                          // Transient like the pre-stream estimate above: the
                          // panel reads it from onData state, so keeping it out
                          // of the message list is what the client expects. A
                          // non-transient copy would be appended to the
                          // assistant message once per tool step — persisted,
                          // re-appended on every replay, and one more chance for
                          // the SDK to open a message of its own to hold it.
                          transient: true,
                        });
                      } catch (error) {
                        logger.warn(
                          { error, conversationId },
                          "[ContextWindow] failed to refresh breakdown after tool step",
                        );
                      }
                    }
                  },
                  onFinish: async ({ usage, finishReason }) => {
                    // abort listeners are removed in the toUIMessageStream
                    // onFinish, which fires only for the final merged result —
                    // not for discarded empty-response retry attempts, whose
                    // streams we also consume here.
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

                // Forward an explicit sampling override only when the caller set one, so default
                // chat behavior is unchanged. A provider that can't honor it drops it with a warning
                // (surfaced via result.warnings below) rather than erroring.
                if (temperature !== undefined) {
                  streamTextConfig.temperature = temperature;
                }

                // A turn may carry its own depth so a pick made mid-conversation
                // applies to the message it was made for, rather than to
                // whatever the row says once the write lands.
                //
                // Not `??`: null is a turn asking for auto, and coalescing would
                // send it back to the column instead.
                const thinkingEffort =
                  requestedThinkingEffort !== undefined
                    ? requestedThinkingEffort
                    : conversation.thinkingEffort;

                const googleProviderOptions = buildGeminiProviderOptions({
                  provider,
                  selectedModel,
                  isGeminiImageModel,
                  thinkingEffort,
                });
                if (googleProviderOptions) {
                  streamTextConfig.providerOptions = {
                    ...streamTextConfig.providerOptions,
                    google: googleProviderOptions,
                  };
                }

                // Nothing else writes the `anthropic` key, so this may assign
                // it outright.
                const anthropicProviderOptions = buildAnthropicProviderOptions({
                  provider,
                  selectedModel,
                  thinkingEffort,
                });
                if (anthropicProviderOptions) {
                  streamTextConfig.providerOptions = {
                    ...streamTextConfig.providerOptions,
                    anthropic: anthropicProviderOptions,
                  };
                }

                // Spread into whichever `openai` block below applies rather
                // than assigned here: both build a fresh object, so a third
                // assignment would drop what they set.
                const openAiThinkingProviderOptions =
                  buildOpenAiThinkingProviderOptions({
                    provider,
                    selectedModel,
                    thinkingEffort,
                  });

                // Responses-routed OpenAI models run with store:false so the
                // SDK resends the full conversation (with encrypted reasoning)
                // each turn instead of referencing server-stored items by id.
                // Item references break on the stateless ChatGPT-subscription
                // (Codex) backend, which forces store:false and therefore never
                // has the referenced items ("Items are not persisted when
                // `store` is set to false").
                //
                // They also reason by default and bill reasoning tokens either
                // way, but only stream human-readable summaries when asked —
                // request them so chat surfaces thinking it already pays for.
                // Unverified OpenAI orgs reject the whole request over the
                // summary option, so it is skipped while the credential is
                // negative-cached as unsupported (the runAgentStream recovery
                // marks it and retries the rejected turn without summaries).
                const openAiReasoningSummaryKey =
                  provider === "openai" &&
                  requiresOpenAiResponsesApi(selectedModel)
                    ? openAiReasoningSummaryCacheKey({
                        organizationId,
                        llmApiKeyId: chatApiKeyId ?? null,
                      })
                    : null;
                if (openAiReasoningSummaryKey !== null) {
                  const summariesUnsupported =
                    await isOpenAiReasoningSummaryMarkedUnsupported(
                      openAiReasoningSummaryKey,
                    );
                  streamTextConfig.providerOptions = {
                    ...streamTextConfig.providerOptions,
                    openai: {
                      store: false,
                      ...(summariesUnsupported
                        ? {}
                        : { reasoningSummary: "auto" }),
                      ...openAiThinkingProviderOptions,
                    },
                  };
                }

                // Perplexity Agent API models (the provider's Responses
                // transport). The key is literally `openai` because the SDK
                // picks that namespace from the transport rather than the
                // provider name.
                //
                // `store: false` — the Agent API stores nothing, so there are
                // no server-side item ids to point back at. The SDK's
                // Responses converter defaults `store` to true and then
                // replaces each earlier assistant text and tool call that
                // carries an item id with `{ type: "item_reference", id }` —
                // references the second turn of every conversation would send
                // and Perplexity could not resolve.
                //
                // The reasoning options exist because the SDK gates its whole
                // reasoning request path on OpenAI's own model-name heuristic
                // (o1/o3/gpt-5*), which no vendor-prefixed Perplexity id
                // matches: without `forceReasoning` the request carries no
                // `reasoning` block, so reasoning models answer with their
                // thinking withheld and chat shows none. Forcing it also
                // flips the SDK's system-message default to the `developer`
                // role, so `systemMessageMode` pins the plain `system` role
                // every vendor behind this cross-vendor catalog accepts.
                if (
                  provider === "perplexity" &&
                  requiresPerplexityAgentApi(selectedModel)
                ) {
                  streamTextConfig.providerOptions = {
                    ...streamTextConfig.providerOptions,
                    openai: {
                      store: false,
                      forceReasoning: true,
                      reasoningSummary: "auto",
                      systemMessageMode: "system",
                    },
                  };
                }

                // Request the model's real output ceiling (clamped by the
                // operator ceiling), or a safe fallback when it is unknown.
                // Without this, providers that inject a small default max
                // (e.g. Anthropic's ~4096) truncated large tool-call payloads
                // and final submission turns.
                const maxOutputTokens = resolveAgentMaxOutputTokens({
                  // Resolved, so an admin-set max-output override on a model
                  // whose provider reports no limit is what the turn asks for.
                  outputLength: modelRow
                    ? ModelModel.resolveEffectiveOutputLength(modelRow)
                    : null,
                  ceiling: config.chat.maxOutputTokensCeiling,
                  rateMeteredCeiling:
                    config.chat.rateMeteredMaxOutputTokensCeiling,
                  provider,
                  // Effective (not architectural) window: for Ollama the
                  // admin-pinned `num_ctx` is what the request actually runs
                  // with, and it is the budget's fallback source.
                  contextLength: modelRow
                    ? ModelModel.resolveEffectiveContextLength(modelRow)
                    : null,
                });
                if (
                  provider === "openai" &&
                  !requiresOpenAiResponsesApi(selectedModel)
                ) {
                  // OpenAI chat-completions models get the budget as
                  // max_completion_tokens (accepted by every OpenAI chat model)
                  // instead of maxOutputTokens: the SDK maps the latter to the
                  // legacy max_tokens for model names its reasoning heuristic
                  // doesn't recognize (e.g. the bare `chat-latest` alias), and
                  // newer models reject max_tokens outright.
                  streamTextConfig.providerOptions = {
                    ...streamTextConfig.providerOptions,
                    openai: {
                      maxCompletionTokens: maxOutputTokens,
                      ...openAiThinkingProviderOptions,
                    },
                  };
                } else {
                  streamTextConfig.maxOutputTokens = maxOutputTokens;
                }

                // vLLM and Ollama's `/v1` speak `reasoning_effort` too, but
                // their depth cannot ride the `openai` key above: those models
                // are built by @ai-sdk/openai-compatible, which reads its
                // options from the fixed `openaiCompatible` namespace rather
                // than from the name each provider instance was created with.
                // Anything under that instance name is passed through only when
                // the key is NOT one the package already knows, so a
                // `providerOptions.vllm.reasoningEffort` is filtered out and
                // silently reaches nothing.
                //
                // vLLM turns the field into its chat template's thinking switch
                // and Ollama into `think` — which is how a depth reaches a
                // self-hosted model at all.
                if (
                  isThinkingEffortSelfHostedProvider(provider) &&
                  openAiThinkingProviderOptions
                ) {
                  streamTextConfig.providerOptions = {
                    ...streamTextConfig.providerOptions,
                    openaiCompatible: {
                      ...streamTextConfig.providerOptions?.openaiCompatible,
                      ...openAiThinkingProviderOptions,
                    },
                  };
                }

                // Send the per-model generation parameters
                // (num_ctx, num_predict, top_k, think, …) on native Ollama turns.
                // These are the values `/v1` cannot carry; the native adapter
                // forwards them into the `/api/chat` `options` bag. Must run
                // AFTER the budget above: Ollama reads the output cap from
                // `options.num_predict`, and the top-level `maxOutputTokens` the
                // AI SDK emits is discarded by the native endpoint.
                if (provider === "ollama-native") {
                  const ollamaTurn = buildOllamaNativeProviderOptions({
                    configured: modelRow?.configuredParameters,
                    requestTemperature: temperature,
                    maxOutputTokens: streamTextConfig.maxOutputTokens,
                    effectiveContextLength: modelRow
                      ? ModelModel.resolveEffectiveContextLength(modelRow)
                      : null,
                    // Ollama shares num_ctx between prompt and generation, so
                    // the budget is trimmed to what this prompt leaves.
                    promptTokens: latestBreakdown?.usedTokens ?? null,
                  });
                  if (ollamaTurn) {
                    streamTextConfig.providerOptions = {
                      ...streamTextConfig.providerOptions,
                      ...ollamaTurn.providerOptions,
                    };
                    // Carries the explicit-thinking marker to the fetch wrapper,
                    // which strips it before the request leaves this process.
                    if (ollamaTurn.headers) {
                      streamTextConfig.headers = {
                        ...streamTextConfig.headers,
                        ...ollamaTurn.headers,
                      };
                    }
                  }
                }

                const { result, getAbortiveFinishReason } =
                  await runAgentStream({
                    config: streamTextConfig,
                    recovery: {
                      logContext: { conversationId },
                      ...(openAiReasoningSummaryKey !== null
                        ? {
                            onReasoningSummaryUnsupported: () =>
                              markOpenAiReasoningSummaryUnsupported(
                                openAiReasoningSummaryKey,
                              ),
                          }
                        : {}),
                      onEmptyResponseExhausted: async () => {
                        // Persist before the throw — nothing has merged yet, so the
                        // stream onError/onFinish won't fire to do it.
                        if (claimMessagesPersisted()) {
                          try {
                            await persistNewMessages(
                              conversationId,
                              messages,
                              "onExecuteError",
                              lockedChatKey,
                            );
                          } catch (persistError) {
                            logger.error(
                              { persistError, conversationId },
                              "Failed to persist messages during empty-response error",
                            );
                          }
                        }
                      },
                    },
                  });
                // The committed result's steps finish after this point; allow
                // their usage events through (discarded attempts already drained).
                hasCommittedResult = true;

                // Surface provider warnings (e.g. a sampling param dropped for a reasoning model)
                // without blocking the stream, so a silently-ignored `temperature` is diagnosable.
                void Promise.resolve(result.warnings)
                  .then((warnings) => {
                    if (warnings && warnings.length > 0) {
                      logger.info(
                        { conversationId, warnings },
                        "Chat stream provider warnings",
                      );
                    }
                  })
                  .catch(() => {});

                // toUIMessageStream invokes onError twice for the same upstream
                // error: first with the real error to build the chunk's
                // errorText, then again as the chunk is walked downstream — but
                // that second call wraps the previous return value in a fresh
                // `new Error(errorText)` (process-ui-message-stream.ts), so the
                // two share no object identity. We dedupe by signature instead:
                // track every payload we've returned and replay it when an
                // incoming error's message matches one. This collapses the
                // duplicate notification while still handling distinct errors
                // (e.g. two unavailable tools in one step) independently.
                const returnedChatErrorPayloads = new Set<string>();

                const modelUiStream = result.toUIMessageStream({
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
                    const incomingErrorMessage =
                      error instanceof Error ? error.message : String(error);
                    if (returnedChatErrorPayloads.has(incomingErrorMessage)) {
                      return incomingErrorMessage;
                    }

                    const unavailableToolError =
                      getUnavailableToolErrorDetails(error);
                    if (unavailableToolError) {
                      const serializedToolError =
                        formatUnavailableToolErrorDetails(unavailableToolError);
                      returnedChatErrorPayloads.add(serializedToolError);
                      logger.info(
                        {
                          conversationId,
                          unavailableToolError,
                        },
                        "Returning unavailable tool error as tool-level error",
                      );
                      return serializedToolError;
                    }

                    // Use pre-built error from subagent if available (preserves correct provider),
                    // otherwise map the error with the current provider
                    const serializedChatError = buildStreamErrorPayload({
                      error,
                      mappedError:
                        error instanceof ProviderError
                          ? error.chatErrorResponse
                          : mapProviderError(error, provider),
                      conversationId,
                      slimChatErrorUi,
                      redactPersistedError: conversation.lockedChat,
                      lockedChatAudit,
                      stage: "via stream",
                    });
                    returnedChatErrorPayloads.add(serializedChatError);

                    activeRunError =
                      error instanceof Error ? error.message : String(error);
                    // Claim persistence before the async work below starts,
                    // otherwise onFinish can race and also persist (duplicates).
                    const shouldPersist = claimMessagesPersisted();

                    (async () => {
                      logger.error(
                        {
                          // LockedChat: errors routinely echo prompt/tool
                          // content — keep the app log content-free.
                          error: conversation.lockedChat
                            ? "[redacted: locked chat]"
                            : error,
                          conversationId,
                          agentId,
                          ...getCorrelationLogFields(getActiveTraceContext()),
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
                            lockedChatKey,
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

                    return serializedChatError;
                  },
                  onFinish: async ({ messages: finalMessages }) => {
                    removeAbortListeners();
                    stopActiveRunPolling();
                    unsubscribeDualLlmProgress();

                    // Splice the turn's collected hook runs into the assistant
                    // message(s) as inline `data-hook-run` parts before persisting,
                    // so they survive refresh and sit at their lifecycle position.
                    const messagesToPersist = applyDualLlmAnalysesToMessages(
                      applyMcpTasksToMessages(
                        applySubagentToolCallsToMessages(
                          applyHookRunsToMessages(
                            finalMessages as unknown as ChatMessage[],
                            hookRunCollector,
                          ),
                          subagentToolStream.collected(),
                        ),
                        chatTaskBridge.collected(),
                      ),
                      dualLlmAnalysisStream.collected(),
                    );

                    // Only persist if not already persisted by onError
                    if (!messagesPersisted && conversationId) {
                      try {
                        if (trigger === "regenerate-message") {
                          // Replace the regenerated turn atomically: delete the
                          // stale messages below the anchor and write the new
                          // turn in one transaction (no destructive pre-delete).
                          await persistRegeneratedTurn({
                            conversationId,
                            requestMessages: messages,
                            finalMessages: messagesToPersist,
                            conversationKey: lockedChatKey,
                          });
                        } else {
                          await persistNewMessages(
                            conversationId,
                            messagesToPersist,
                            "onFinish",
                            lockedChatKey,
                          );
                        }
                        messagesPersisted = true;
                      } catch (error) {
                        logger.error(
                          { error, conversationId },
                          "Failed to persist messages during onFinish",
                        );
                      }
                    }

                    // Verifiable citations (issue #7161): check the turn's
                    // cited quotes against the chunks query_knowledge_sources
                    // returned (captured at execution time, run_tool dispatches
                    // included). Runs here — on the final merged result — so
                    // every step's user-visible text is covered; streamText's
                    // own onFinish sees only the final step's text. Log-only
                    // and best-effort: a failure must never disturb the
                    // finished answer.
                    if (kbChunksCollector) {
                      try {
                        verifyChatCitedQuotes({
                          chunks: kbChunksCollector,
                          answerText: extractTurnAnswerText(
                            finalMessages as unknown as ChatMessage[],
                          ),
                          conversationId,
                          agentId,
                        });
                      } catch (error) {
                        logger.warn(
                          { error, conversationId },
                          "KB quote verification failed",
                        );
                      }
                    }
                  },
                });

                // Inject data-tool-ui-start right after each tool-input-start
                // chunk (see createToolUiStartTransform — kept out of onChunk so
                // the empty-response probe can't emit it before its own tool).
                // The abortive-turn tracker taps the same merged stream to spot a
                // tool call the model started but never completed and, on stream
                // end, appends the same retryable error a clean-but-empty turn
                // would surface — instead of completing silently. The start-of-
                // stream probe can't catch this: the turn opened with renderable
                // content. Emitting from the tracker's flush keeps it in stream
                // order and avoids an execute-side await on a not-yet-drained
                // stream.
                writer.merge(
                  modelUiStream
                    .pipeThrough(
                      // Releases the dual-LLM bridge's buffered analysis parts
                      // once the model stream has opened — writing them any
                      // earlier mints a phantom assistant message client-side.
                      // Flushed on the second chunk, not the first: the merge
                      // pump has provably forwarded the `start` chunk to the
                      // outbound stream before this transform sees chunk two,
                      // so a side-write can no longer overtake it.
                      (() => {
                        let chunksSeen = 0;
                        return new TransformStream({
                          transform(chunk, controller) {
                            controller.enqueue(chunk);
                            chunksSeen++;
                            if (chunksSeen >= 2) {
                              dualLlmAnalysisStream.markStreamStarted();
                            }
                          },
                        });
                      })(),
                    )
                    .pipeThrough(
                      createToolUiStartTransform({
                        prefetchedUiResources,
                        toolUiResourceUris,
                      }),
                    )
                    .pipeThrough(
                      createAbortiveTurnTracker({
                        onUnresolvedToolCall: () => {
                          if (
                            chatAbortController.signal.aborted ||
                            activeRunError ||
                            !conversationId
                          ) {
                            return null;
                          }
                          // Prefer the probe's finishReason (authoritative when
                          // the committed turn's onStepFinish fired during the
                          // probe, before hasCommittedResult); fall back to the
                          // step-captured one for a turn that opened with content.
                          const mappedError = buildAbortiveTurnError(
                            provider,
                            getAbortiveFinishReason() ?? lastFinishReason,
                          );
                          activeRunError = mappedError.message;
                          return {
                            type: "error",
                            errorText: buildStreamErrorPayload({
                              error: new Error(mappedError.message),
                              mappedError,
                              conversationId,
                              slimChatErrorUi,
                              redactPersistedError: conversation.lockedChat,
                              lockedChatAudit,
                              stage: "via stream",
                            }),
                          };
                        },
                      }),
                    ),
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
                      cacheReadTokens: usage.cachedInputTokens,
                    } satisfies TokenUsage,
                  });
                }

                clearInterval(heartbeatInterval);
              },
            });

            return await sendGatedUiMessageStreamResponse({
              // LockedChat: replay events carry raw stream chunks in
              // plaintext, so payload persistence is suppressed (reconnect
              // replay is lost; the run still completes server-side with the
              // key held in this request's closure).
              lockedChatAudit,
              // Suppress only when there is nothing to encrypt under: an
              // locked-chat run WITH a key now persists its replay payloads
              // encrypted, so reconnect-after-reload works for it.
              suppressEventPayloads:
                conversation.lockedChat && !lockedChatAudit,
              reply,
              stream: uiMessageStream as ReadableStream<UIMessageChunk>,
              runId: activeRun.id,
              conversationId,
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
          },
        });
      } catch (error) {
        if (!chatAbortController.signal.aborted) {
          chatAbortController.abort();
        }
        stopActiveRunPolling();
        unsubscribeDualLlmProgress();
        await activeChatRunService.markTerminal({
          runId: activeRun.id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  fastify.post(
    "/api/chat/elicitation/:id",
    {
      schema: {
        operationId: RouteId.ResolveChatMcpElicitation,
        description: "Resolve a pending MCP elicitation request from chat",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: ChatMcpElicitationResponseSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const conversation = await ConversationModel.findById({
        id: body.conversationId,
        userId: user.id,
        organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      await resolveChatMcpElicitation({ id, response: body });

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/chat/tasks/:taskId/cancel",
    {
      schema: {
        operationId: RouteId.CancelChatMcpTask,
        description: "Cancel a long-running MCP task started from chat",
        tags: ["Chat"],
        params: z.object({ taskId: UuidIdSchema }),
        response: constructResponseSchema(z.object({ cancelled: z.boolean() })),
      },
    },
    async ({ params: { taskId }, user }, reply) => {
      // The principal match inside the model is the authorization: another
      // user's task reports false rather than cancelling, and is
      // indistinguishable from one that had already finished.
      const cancelled = await McpGatewayTaskModel.cancelForPrincipal({
        taskId,
        principal: chatTaskPrincipal(user.id),
      });

      // Only reachable once the row flip proved ownership. Aborts the in-flight
      // call when it is running on this replica; elsewhere the row is what the
      // polling turn sees. Whether the upstream server stops working is up to
      // it — cancellation is cooperative.
      if (cancelled) {
        mcpGatewayTaskRunner.abort(taskId);
      }

      return reply.send({ cancelled });
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
      if (streamId) {
        const stopKey = `${CacheKey.ChatStop}-${streamId}` as const;
        try {
          await cacheManager.set(stopKey, true, TimeInMs.Minute);
        } catch (error) {
          logger.warn(
            { error, conversationId: id, streamId },
            "Failed to set chat stop cache flag",
          );
        }
      }

      // A successful Stop response is the submission hand-off barrier: do not
      // let the client close its local stream and accept a new turn until the
      // old run has durably left `running`. Otherwise the next POST can race
      // the unique active-run guard and fail with a duplicate-run 409.
      if (activeRun) {
        await activeChatRunService.waitForTerminal(activeRun.id);
      }
      return reply.send({ stopped: !!activeRun || !!streamId });
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
    async (request, reply) => {
      const { id } = request.params;
      const { user, organizationId } = request;
      const conversation = await ConversationModel.findAccessibleById({
        id,
        userId: user.id,
        organizationId,
        canReadOthersViaProject: () =>
          userHasPermission(user.id, organizationId, "project", "read-all"),
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      // Replay payloads of a locked-chat run are encrypted under the browser
      // key, so reconnecting needs it presented again. Without it the reader
      // yields nothing rather than failing the reconnect.
      const replayKeyInfo = conversation.lockedChat
        ? await ConversationModel.getLockedChatKeyInfo(id)
        : null;
      const replayLockedChatAudit =
        replayKeyInfo?.hasEscrow === true
          ? requireLockedChatKey({
              request,
              conversation: replayKeyInfo,
            })
          : null;

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
        stream: activeChatRunService.createReplayStream(
          activeRun.id,
          replayLockedChatAudit,
        ),
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

  // Registered before `/conversations/:id` so the static `deleted` segment is
  // unambiguous (find-my-way prioritizes static over parametric regardless, and
  // `:id` is a UUID so "deleted" would 400 there anyway — this keeps it clear).
  fastify.get(
    "/api/chat/conversations/deleted",
    {
      schema: {
        operationId: RouteId.GetDeletedChatConversations,
        description:
          "List the current user's soft-deleted conversations (the Trash view), newest deletion first.",
        tags: ["Chat"],
        response: constructResponseSchema(z.array(SelectConversationSchema)),
      },
    },
    async (request, reply) => {
      return reply.send(
        await ConversationModel.findAllDeleted(
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
    async (request, reply) => {
      const {
        params: { id },
        user,
        organizationId,
      } = request;
      const conversation = await findReadableConversationById({
        conversationId: id,
        userId: user.id,
        organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      // LockedChat: the model returned no message content (it cannot — the key
      // only exists on this request). Decrypt here with the presented key, or
      // return the locked shape for the tombstone. A wrong key is a 409.
      if (conversation.lockedChat) {
        const keyInfo = await ConversationModel.getLockedChatKeyInfo(id);
        const access = resolveLockedChatAccess({
          request,
          conversation: keyInfo ?? {
            id,
            lockedChat: true,
            lockedChatDekFingerprint: null,
            hasEscrow: false,
          },
        });
        if (access.state === "unlocked") {
          // Chat errors are loaded locked-safe by the model (it has no key),
          // so re-read them here now that one is in hand.
          const [rows, chatErrors] = await Promise.all([
            MessageModel.findByConversation(id, access.key),
            ConversationChatErrorModel.findByConversation(id, access.key),
          ]);
          conversation.messages = toConversationApiMessages(
            rows,
          ) as typeof conversation.messages;
          conversation.chatErrors = chatErrors;
        } else {
          conversation.messages = [];
          conversation.contentLocked = true;
          return reply.send(conversation);
        }
      }

      // Hook-run debug parts are persisted on every turn but only surfaced to
      // admins while this conversation has debug mode on. Strip them otherwise
      // so hook stdout/stderr/payload never reach a non-admin client. (When
      // debug is off we skip the permission lookup entirely.)
      const hooksDebugVisible =
        config.hooks.enabled &&
        conversation.hooksDebugEnabled &&
        (await hasAnyAgentTypeAdminPermission({
          userId: user.id,
          organizationId,
        }));
      conversation.messages = stripHookRunParts(
        conversation.messages as ChatMessage[],
        { visible: hooksDebugVisible },
      );

      return reply.send(conversation);
    },
  );

  fastify.post(
    "/api/chat/conversations/:id/hooks-debug",
    {
      schema: {
        operationId: RouteId.SetConversationHooksDebug,
        description:
          "Toggle per-conversation hook debug mode (admin only). When on, hook runs surface inline as expandable debug chips for admins.",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: z.object({ enabled: z.boolean() }),
        response: constructResponseSchema(
          z.object({ hooksDebugEnabled: z.boolean() }),
        ),
      },
    },
    async ({ params: { id }, body: { enabled }, user, organizationId }) => {
      if (!config.hooks.enabled) {
        throw new ApiError(404, "Agent hooks are not enabled");
      }
      const isAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      if (!isAdmin) {
        throw new ApiError(403, "Hook debug mode is admin only");
      }

      const updated = await ConversationModel.setHooksDebugEnabled({
        id,
        userId: user.id,
        organizationId,
        enabled,
      });
      if (updated === null) {
        throw new ApiError(404, "Conversation not found");
      }

      return { hooksDebugEnabled: updated };
    },
  );

  fastify.post(
    "/api/chat/conversations/:id/read",
    {
      schema: {
        operationId: RouteId.MarkChatConversationRead,
        description:
          "Mark a conversation read by its owner, clearing the sidebar new-messages indicator.",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id }, user, organizationId }) => {
      const marked = await ConversationModel.markRead({
        id,
        userId: user.id,
        organizationId,
      });
      if (!marked) {
        throw new ApiError(404, "Conversation not found");
      }

      return { success: true };
    },
  );

  fastify.get(
    "/api/chat/conversations/:id/files",
    {
      schema: {
        operationId: RouteId.GetChatConversationFiles,
        description:
          "List files for a conversation: this chat's own outputs, user attachments, and — for a project chat — every file in the project (metadata only).",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(ConversationFilesResponseSchema),
      },
    },
    async (request, reply) => {
      const {
        params: { id },
        user,
        organizationId,
      } = request;
      const conversation = await findReadableConversationById({
        conversationId: id,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      // Listing a locked chat's files works with or without the key: without
      // it the panel still shows that files exist (and their type and date),
      // which is the same tombstone posture the transcript takes.
      const access = resolveLockedChatAccess({
        request,
        conversation: (await ConversationModel.getLockedChatKeyInfo(id)) ?? {
          id,
          lockedChat: conversation.lockedChat,
          lockedChatDekFingerprint: null,
        },
      });

      return reply.send(
        await conversationFilesService.list({
          conversationId: id,
          organizationId,
          requestingUserId: user.id,
          conversationKey: access.state === "unlocked" ? access.key : null,
        }),
      );
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
    async (request, reply) => {
      const {
        params: { id },
        user,
        organizationId,
      } = request;
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

      // In a locked chat the bytes and the filename are sealed under the key
      // this browser holds, so serving them needs it on the request. A reader
      // without it (another member reaching the chat through the project) gets
      // a 400 naming the header rather than a body of ciphertext.
      const attachmentKey = meta.lockedChat
        ? requireLockedChatKey({
            request,
            conversation: (await ConversationModel.getLockedChatKeyInfo(
              meta.conversationId,
            )) ?? {
              id: meta.conversationId,
              lockedChat: true,
              lockedChatDekFingerprint: null,
            },
          })
        : null;

      const attachment = await ConversationAttachmentModel.findByIdWithData(
        id,
        attachmentKey,
      );
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
        // `sandbox` blocks Chrome's PDF viewer outright — a sandboxed PDF
        // response renders as a grey box — so PDFs get a narrower policy and
        // the Files panel can actually preview them. PDF script runs inside
        // the viewer plugin, isolated from the page and our origin.
        "Content-Security-Policy":
          safeMime === "application/pdf"
            ? "frame-ancestors 'self'"
            : "default-src 'none'; sandbox",
        // A locked chat's bytes are opened only for this response, so they must
        // not be written to the browser's on-disk HTTP cache: that copy is
        // plaintext, outlives the tab, and is not reachable by the key —
        // precisely the at-rest copy the chat exists to avoid. Everything else
        // keeps the shared cache window.
        "Cache-Control": meta.lockedChat ? "no-store" : "private, max-age=3600",
        "Content-Length": String(attachment.fileSize),
      });
      reply.raw.end(attachment.fileData);
      return reply;
    },
  );

  fastify.delete(
    "/api/chat/attachments/:id",
    {
      schema: {
        operationId: RouteId.DeleteChatAttachment,
        description:
          "Soft-delete a chat attachment by id. Owner-gated: only the " +
          "conversation owner may remove its attachments.",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { id }, user, organizationId }) => {
      await conversationFilesService.deleteAttachment({
        attachmentId: id,
        userId: user.id,
        organizationId,
      });
      return { ok: true as const };
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
      if (sourceConversation.lockedChat) {
        throw new ApiError(400, "Locked chats cannot be forked");
      }

      const forked = await forkConversation({
        sourceConversation,
        agentId,
        userId: user.id,
        organizationId,
      });
      // A fresh fork starts with debug off; never echo the source's hook debug
      // parts back in the response.
      forked.messages = stripHookRunParts(forked.messages as ChatMessage[], {
        visible: false,
      });
      return forked;
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
          projectId: true,
          lockedChat: true,
          thinkingEffort: true,
        })
          .required({ agentId: true })
          .partial({
            title: true,
            modelId: true,
            chatApiKeyId: true,
            projectId: true,
            lockedChat: true,
            thinkingEffort: true,
          }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async (request, reply) => {
      const {
        body: {
          agentId,
          title,
          modelId,
          chatApiKeyId,
          projectId,
          lockedChat,
          thinkingEffort,
        },
        user,
        organizationId,
      } = request;
      // Locked chats stay out of projects: a project lists its chats to
      // everyone it is shared with, so a locked one would sit in a shared
      // space advertising a conversation none of them can open.
      if (lockedChat && projectId) {
        throw new ApiError(400, "Locked chats cannot be created in a project");
      }

      // A chat born in a project belongs to it; the caller must be able to
      // read the project. "No access" reads as 404, like the project routes.
      if (projectId) {
        const project = await ProjectModel.findById(projectId);
        if (
          !project ||
          !(await ProjectShareModel.userCanAccessProject({
            project,
            userId: user.id,
            organizationId,
          }))
        ) {
          throw new ApiError(404, "Project not found");
        }
      }

      // Check if user is an agent admin
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      // Validate that the agent exists and the user has access to it. Only the
      // LLM-selection fields are read below, so skip findById's full hydration.
      const agent = await AgentModel.findLlmSelectionFieldsById(
        agentId,
        user.id,
        isAgentAdmin,
      );

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

      // LockedChat: the id is generated up front because the key fingerprint
      // (and any enterprise escrow record, including the Vault-sink write)
      // is bound to it; the browser's key is fingerprinted, never stored
      // raw. The title is static — generation would send content to an LLM
      // and store a derived plaintext title.
      const lockedChatConversationId = lockedChat ? randomUUID() : null;
      const lockedChatFields = lockedChatConversationId
        ? resolveLockedChatCreation({
            request,
            conversationId: lockedChatConversationId,
          })
        : null;

      // Create conversation with agent
      return reply.send(
        await ConversationModel.create({
          ...(lockedChatFields && lockedChatConversationId
            ? {
                id: lockedChatConversationId,
                ...lockedChatFields,
                // Always static: clients derive draft titles from the first
                // message text, which must never land in the plaintext title.
                title: LOCKED_CHAT_STATIC_TITLE,
              }
            : { title }),
          userId: user.id,
          organizationId,
          agentId,
          modelId: llmSelection.modelId,
          chatApiKeyId: llmSelection.chatApiKeyId,
          projectId: projectId ?? null,
          thinkingEffort,
        }),
      );
    },
  );

  fastify.patch(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.UpdateChatConversation,
        description:
          "Update conversation title, model, agent, API key, or project",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateConversationSchema,
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      if (body.projectId) {
        const project = await ProjectModel.findById(body.projectId);
        if (
          !project ||
          !(await ProjectShareModel.userCanAccessProject({
            project,
            userId: user.id,
            organizationId,
          }))
        ) {
          throw new ApiError(404, "Project not found");
        }

        const currentConversation = await ConversationModel.findById({
          id,
          userId: user.id,
          organizationId,
        });
        if (currentConversation?.lockedChat) {
          throw new ApiError(400, "Locked chats cannot be moved to a project");
        }
      }

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

      // LockedChat: the artifact column stores conversation-derived content in
      // plaintext, so the write is silently dropped (the feature no-ops).
      if (body.artifact !== undefined) {
        const lockedChatInfo = await ConversationModel.getLockedChatKeyInfo(id);
        if (lockedChatInfo?.lockedChat) {
          body.artifact = undefined;
        }
      }

      // Coerce pinnedAt ISO string to Date for database storage
      const pinnedAtDate =
        body.pinnedAt != null ? new Date(body.pinnedAt) : body.pinnedAt;
      const updateData: UpdateConversation = {
        ...body,
        pinnedAt: pinnedAtDate,
      };

      // A no-op update (e.g. an artifact write dropped for a locked-chat
      // conversation) must not reach drizzle's `.set()` with zero defined
      // values; answer with the current conversation instead.
      const hasFieldsToSet = Object.values(updateData).some(
        (value) => value !== undefined,
      );
      const conversation = hasFieldsToSet
        ? await ConversationModel.update(
            id,
            user.id,
            organizationId,
            updateData,
          )
        : await ConversationModel.findById({
            id,
            userId: user.id,
            organizationId,
          });

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
      // Owner+org-scoped lookup; findById excludes soft-deleted rows. A miss
      // means the conversation never existed, isn't owned by the caller, or is
      // already deleted — nothing left for this caller to delete, so DELETE
      // stays idempotent and returns success without touching state.
      const conversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        return reply.send({ success: true });
      }

      // Soft-delete: stamp deleted_at so the conversation vanishes from every
      // read path while its rows (messages, runs, shares) AND its object-storage
      // files stay intact — soft delete must be reversible. The old hard-delete
      // purged conversation files here; that purge is intentionally gone.
      // Nothing reclaims these files yet — a scheduled retention job (purge
      // files + hard-delete rows past the window) is planned as a follow-up.
      // The delete count is ignored: a concurrent winner making it 0 is still
      // success for an idempotent DELETE.
      // No audit record is emitted: conversations are intentionally absent from
      // AUDITABLE_ROUTES (see AUDIT_DECISIONS.conversationsTable).
      await ConversationModel.delete(id, user.id, organizationId);

      // Best-effort teardown of live-only resources; failures here must not fail
      // the already-successful delete. The data stays, but an in-flight run and
      // its browser tab are ephemeral and must not keep streaming into a hidden
      // conversation. Soft-delete leaves the run row in place (no cascade), so
      // request an explicit stop: this sets stopRequestedAt on the still-running
      // row, which the stream's stop-poll observes and aborts on.
      try {
        await activeChatRunService.requestStop({
          conversationId: id,
          organizationId,
        });
      } catch (error) {
        logger.warn(
          { error, conversationId: id },
          "Failed to stop active chat run on conversation deletion",
        );
      }

      if (conversation.agentId && browserStreamFeature.isEnabled()) {
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

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/chat/conversations/:id/restore",
    {
      schema: {
        operationId: RouteId.RestoreChatConversation,
        description: "Restore a soft-deleted conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      // Idempotent restore: clear deleted_at (no-op / count 0 when the row is
      // already active). Restore does not resurrect the aborted stream left by
      // delete — history returns, the run stays stopped.
      // No audit record is emitted: conversations are intentionally absent from
      // AUDITABLE_ROUTES (see AUDIT_DECISIONS.conversationsTable — high-volume
      // chat data surfaced via /llm/logs), so restore matches the sibling
      // create/update/delete conversation routes rather than auditing alone.
      const restored = await ConversationModel.restore(
        id,
        user.id,
        organizationId,
      );

      // Both side effects below are gated on the deleted -> active transition,
      // never on the idempotent no-op: a second restore must not reach into a
      // conversation that is already live (and a caller who does not own the
      // row transitions nothing, so neither touches someone else's chat).
      if (restored > 0) {
        // Delete only asked the run to stop. Finish it here so a row nothing is
        // streaming into can't wedge the restored chat behind the running-run
        // unique index until the stale reaper. Best-effort, like the teardown on
        // delete: a restore must not fail over stream bookkeeping.
        try {
          await activeChatRunService.cancelRunForRestoredConversation(id);
        } catch (error) {
          logger.warn(
            { error, conversationId: id },
            "Failed to finalize the stopped chat run on conversation restore",
          );
        }

        // Restore does NOT re-publish. Delete revokes read access for everyone
        // holding the share link (the shares join filters on the soft-delete
        // predicate), and deleting a chat is a plausible way to pull a share
        // back — so silently re-granting org-wide access on the way out of
        // trash would be a surprise with real disclosure consequences. The chat
        // comes back private; the owner re-shares deliberately if they still
        // want to. Not swallowed: a restore that reported success while leaving
        // the chat shared is the exact failure this prevents.
        await ConversationShareModel.delete({
          conversationId: id,
          organizationId,
          userId: user.id,
        });
      }

      // Full hydration, matching this route's declared conversation schema — a
      // caller seeding its conversation cache from this response must get the
      // history back, not an empty shell. Null means the conversation never
      // existed, isn't owned by the caller, or was hard-deleted in a race —
      // nothing to restore, so 404.
      const conversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      return reply.send(conversation);
    },
  );

  fastify.delete(
    "/api/chat/conversations/:id/chat-errors",
    {
      schema: {
        operationId: RouteId.ClearChatConversationErrors,
        description: "Clear a conversation's recorded chat errors",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      // Owner+org-scoped lookup (matches the other conversation mutations) so a
      // caller can only clear errors on a conversation they own.
      const conversation = await ConversationModel.findById({
        id,
        userId: user.id,
        organizationId,
      });
      if (!conversation) {
        throw new ApiError(404, "Conversation not found");
      }

      await ConversationChatErrorModel.deleteByConversation(id);

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

      if (conversation.lockedChat) {
        // Compaction would persist an LLM-derived summary of the content in
        // plaintext (conversation_compactions carries no per-conversation key).
        throw new ApiError(400, "Compaction is not available for locked chats");
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
        modelId: conversation.modelId,
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
      if (conversation.lockedChat) {
        // A share grants read access the recipients could never use (they
        // don't hold the key) and would leak the conversation's existence.
        throw new ApiError(400, "Locked chats cannot be shared");
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

      // Hook debug parts are an owner/admin-only surface — never expose them
      // through a share link, regardless of the viewer or debug flag.
      conversation.messages = stripHookRunParts(
        conversation.messages as ChatMessage[],
        { visible: false },
      );

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

      const forked = await forkConversation({
        sourceConversation: sharedConversation,
        agentId,
        userId: user.id,
        organizationId,
      });
      forked.messages = stripHookRunParts(forked.messages as ChatMessage[], {
        visible: false,
      });
      return forked;
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

      if (conversation.lockedChat) {
        // Title generation sends message content to an LLM and stores a
        // plaintext derived title; locked chats keep their static title.
        return reply.send(conversation);
      }

      // Skip if title is already set (unless regenerating). A placeholder title
      // — an app's name, seeded so an app chat isn't blank before its first
      // exchange — doesn't count as set. The write below clears the flag, so
      // this fires once; a manual rename clears it too, so a name the user
      // typed is never overwritten.
      if (
        conversation.title &&
        !conversation.titleIsPlaceholder &&
        !regenerate
      ) {
        logger.info(
          { conversationId: id, existingTitle: conversation.title },
          "Skipping title generation - title already set",
        );
        return reply.send(conversation);
      }

      // Extract first user and assistant messages
      const { firstUserMessage, firstAssistantMessage, firstUserSkillName } =
        extractFirstMessages(conversation.messages || []);

      // A bare skill invocation persists an empty first user message, so fall
      // back to the invoked skill's name as the user-intent signal; the first
      // assistant reply still supplies the actual topic to the title prompt.
      const titleUserInput = resolveTitleUserInput(
        firstUserMessage,
        firstUserSkillName,
      );

      // Need some user-intent signal (typed text or skill name) to title from.
      if (!titleUserInput) {
        logger.info(
          { conversationId: id },
          "Skipping title generation - no user text or skill found",
        );
        return reply.send(conversation);
      }

      const titleAgent = await AgentModel.getBuiltInAgent(
        BUILT_IN_AGENT_IDS.CHAT_TITLE_GENERATION,
        organizationId,
      );
      // Unless an admin pinned a model on the title subagent, title the
      // conversation with the model the conversation itself runs on — the pair
      // chat resolution already picked and persisted. Falling straight to the
      // organization default meant a chat on one self-hosted model was titled
      // by another, with nothing in the UI to explain it.
      //
      // Except on Microsoft 365 Copilot, which cannot run a title generation at
      // all (see the skip below). Inheriting it would turn a chat that used to
      // get an organization-default title into one that gets none, so leave
      // that conversation to the organization default.
      const conversationModel = conversation.modelId
        ? await ModelModel.findById(conversation.modelId)
        : null;
      const titleLlm = await resolveAgentLlmOrDefault({
        agent: titleAgent,
        inheritFrom:
          conversationModel &&
          conversationModel.provider !== "microsoft-365-copilot"
            ? {
                modelId: conversation.modelId,
                agentLlmApiKeyId: conversation.agent?.llmApiKeyId ?? null,
              }
            : null,
        organizationId,
        userId: user.id,
        conversationId: id,
      });
      const systemPrompt =
        renderSystemPrompt(
          titleAgent?.systemPrompt ?? CHAT_TITLE_GENERATION_SYSTEM_PROMPT,
        ) ?? CHAT_TITLE_GENERATION_SYSTEM_PROMPT;

      logger.debug(
        { conversationId: id, provider: titleLlm.provider },
        "Title generation: resolved built-in agent LLM",
      );

      if (isApiKeyRequired(titleLlm.provider, titleLlm.apiKey)) {
        // Title generation is best-effort. When the resolved model has no usable
        // key for the acting user — e.g. a per-user provider (GitHub Copilot)
        // they haven't connected, which can be inherited from an org/agent
        // default — skip silently instead of failing the request with a generic
        // "configure a key" error. The chat stream already surfaces the inline
        // connect prompt; a redundant toast here would only mislead the member.
        logger.info(
          { conversationId: id, provider: titleLlm.provider },
          "Skipping title generation - no usable API key for the acting user",
        );
        return reply.send(conversation);
      }

      // Microsoft 365 Copilot can't run utility generations: the Graph Chat
      // API has a fixed product persona and takes our system prompt only as
      // riding-along additional context, which it routinely ignores — instead
      // of a title it answers the message (a greeting, emoji included, became
      // the stored title). Skip so the client keeps its first-user-message
      // fallback.
      if (titleLlm.provider === "microsoft-365-copilot") {
        logger.info(
          { conversationId: id },
          "Skipping title generation - Microsoft 365 Copilot does not follow title instructions",
        );
        return reply.send(conversation);
      }

      // Generate title using the extracted function
      const generatedTitle = await generateConversationTitle({
        ...titleLlm,
        agentId: titleAgent?.id ?? id,
        userId: user.id,
        conversationId: id,
        systemPrompt,
        firstUserMessage: titleUserInput,
        firstAssistantMessage,
      });

      // The model can decline to name the conversation — it answers with a
      // paragraph, or a reasoning model spends the whole ceiling thinking and
      // writes nothing. Settle on the opening words of the first message rather
      // than leaving the chat untitled; the client shows the same shape while
      // generation is in flight, so this only makes that state permanent.
      // `generateConversationTitle` has already logged which of those happened.
      const title = generatedTitle ?? toPlaceholderTitle(titleUserInput);
      const titleSource = generatedTitle !== null ? "model" : "fallback";

      if (title === conversation.title && !conversation.titleIsPlaceholder) {
        // Most often the fallback matched the placeholder the client stored
        // when it opened the chat. Writing it again would touch the row — and
        // reorder the sidebar — to leave the title exactly as it was.
        //
        // Only when the row isn't flagged a placeholder, though: the write
        // below is also what clears that flag, and skipping it would leave an
        // app chat asking to be retitled on every open.
        logger.info(
          { conversationId: id, title, titleSource },
          "Skipping title update - the new title is identical to the stored one",
        );
        return reply.send(conversation);
      }

      logger.info(
        { conversationId: id, title, titleSource },
        "Updating conversation title",
      );

      // Compare-and-set on the title read before generation. The LLM call above
      // takes seconds, and a rename landing in that window must survive — an
      // app chat's placeholder title is unhelpful, so renaming while the reply
      // streams is ordinary behaviour, and the model's guess must not win. The
      // fallback is written through the same guard: a rename outranks the
      // opening words just as it outranks a generated title.
      const updatedConversation =
        await ConversationModel.updateTitleIfUnchanged({
          id,
          userId: user.id,
          organizationId,
          expectedTitle: conversation.title,
          expectedTitleIsPlaceholder: conversation.titleIsPlaceholder,
          title,
        });

      if (!updatedConversation) {
        // Either the conversation was deleted during the async title generation
        // or its title changed under us. Both are benign races, not server
        // faults: title generation is best-effort, so fall through gracefully
        // like the other skip branches above instead of raising a 500.
        logger.info(
          { conversationId: id },
          "Skipping title update - conversation deleted or retitled during generation",
        );
        // Re-read rather than replying with the pre-generation snapshot: the
        // client merges this response into its conversation cache, so a stale
        // title here would put the placeholder back on screen even though the
        // rename survived in the database. Null means deleted, nothing to show.
        const current = await ConversationModel.findById({
          id,
          userId: user.id,
          organizationId,
        });
        return reply.send(current ?? conversation);
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
          conversationId: z.string(),
          partIndex: z.number().int().min(0),
          text: z.string().min(1),
          deleteSubsequentMessages: z.boolean().optional(),
        }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async (request, reply) => {
      const {
        params: { id },
        body: { conversationId, partIndex, text, deleteSubsequentMessages },
        user,
        organizationId,
      } = request;
      // Verify the user has access to the conversation FIRST — the message
      // lookup is scoped to it. Content ids (AI SDK nanoids, used until page
      // reload) are client-supplied and non-unique across conversations, and
      // the scoped lookup also stays correct under content encryption.
      const conversation = await ConversationModel.findById({
        id: conversationId,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!conversation) {
        throw new ApiError(404, "Message not found or access denied");
      }

      const editKey = conversation.lockedChat
        ? requireLockedChatKey({
            request,
            conversation: (await ConversationModel.getLockedChatKeyInfo(
              conversationId,
            )) ?? {
              id: conversationId,
              lockedChat: true,
              lockedChatDekFingerprint: null,
            },
          })
        : null;

      const message = await MessageModel.findByAnyIdInConversation(
        id,
        conversationId,
        editKey,
      );

      if (!message) {
        throw new ApiError(404, "Message not found");
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
          editKey,
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

  // Message Feedback Route
  fastify.patch(
    "/api/chat/messages/:id/feedback",
    {
      schema: {
        operationId: RouteId.SetChatMessageFeedback,
        description:
          "Set or clear the owner's thumbs feedback on an assistant message",
        tags: ["Chat"],
        params: z.object({ id: z.string() }),
        body: z.object({
          conversationId: z.string().uuid(),
          // union (not .nullable()): the OpenAPI 3.0 `nullable: true` + `enum`
          // combination loses `null` in the generated hey-api client type
          feedback: z.union([ChatMessageFeedbackSchema, z.null()]),
        }),
        response: constructResponseSchema(
          z.object({
            id: z.string().uuid(),
            feedback: z.union([ChatMessageFeedbackSchema, z.null()]),
          }),
        ),
      },
    },
    async (request, reply) => {
      const {
        params: { id },
        body: { conversationId, feedback },
        user,
        organizationId,
      } = request;
      // Verify the user owns the conversation before resolving the message.
      // isOwnedBy, not findById: this endpoint only needs the ownership check,
      // and findById drags every message body along with it.
      const isOwner = await ConversationModel.isOwnedBy({
        id: conversationId,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!isOwner) {
        throw new ApiError(404, "Message not found or access denied");
      }

      // LockedChat rows can only be resolved-by-content-id (and returned)
      // after decryption with the browser-held key.
      const feedbackKeyInfo =
        await ConversationModel.getLockedChatKeyInfo(conversationId);
      const feedbackKey = feedbackKeyInfo?.lockedChat
        ? requireLockedChatKey({ request, conversation: feedbackKeyInfo })
        : null;

      // Resolve by DB UUID or AI SDK nanoid content ID, scoped to the
      // conversation — content IDs are client-supplied and not globally unique
      const message = await MessageModel.findByAnyIdInConversation(
        id,
        conversationId,
        feedbackKey,
      );

      if (!message) {
        throw new ApiError(404, "Message not found");
      }

      if (message.role !== "assistant") {
        throw new ApiError(
          400,
          "Feedback is only supported on assistant messages",
        );
      }

      const updatedMessage = await MessageModel.updateFeedback(
        message.id,
        feedback,
        feedbackKey,
      );

      // The row can vanish between lookup and update (e.g. a concurrent
      // regeneration deleted this assistant turn)
      if (!updatedMessage) {
        throw new ApiError(404, "Message not found");
      }

      reportChatMessageFeedback(updatedMessage.feedback ?? null);

      return reply.send({
        id: updatedMessage.id,
        feedback: updatedMessage.feedback ?? null,
      });
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
      // Verify conversation exists and user owns it. isOwnedBy, not findById:
      // this endpoint only needs the ownership check, and findById drags every
      // message body along with it.
      const ownsConversation = await ConversationModel.isOwnedBy({
        id: id,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!ownsConversation) {
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
      // Verify conversation exists and user owns it (see the GET handler on
      // why this is isOwnedBy rather than findById)
      const ownsConversation = await ConversationModel.isOwnedBy({
        id: id,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!ownsConversation) {
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
      // Verify conversation exists and user owns it (see the GET handler on
      // why this is isOwnedBy rather than findById)
      const ownsConversation = await ConversationModel.isOwnedBy({
        id: id,
        userId: user.id,
        organizationId: organizationId,
      });

      if (!ownsConversation) {
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
  metadata?: unknown;
}

/**
 * Result of extracting first messages from a conversation
 */
export interface ExtractedMessages {
  firstUserMessage: string;
  firstAssistantMessage: string;
  /**
   * Name of the skill the user invoked on the first user message, if any. A bare
   * slash-command invocation persists an empty text part plus skill metadata, so
   * `firstUserMessage` is empty; the skill name is the only typed-intent signal
   * available to title generation in that case.
   */
  firstUserSkillName: string | null;
}

// Cap the skill name pulled from (client-controlled) message metadata before it
// reaches the title prompt.
const MAX_SKILL_NAME_LENGTH = 80;

/**
 * Extracts the first exchange — the first user message and the first assistant
 * message that follows it — from conversation messages, for title generation.
 */
export function extractFirstMessages(messages: unknown[]): ExtractedMessages {
  let firstUserMessage = "";
  let firstAssistantMessage = "";
  let firstUserSkillName: string | null = null;
  let sawFirstUser = false;

  for (const msg of messages) {
    const msgContent = msg as Message;
    if (msgContent.role === "user" && !sawFirstUser) {
      sawFirstUser = true;
      // Collapse whitespace (incl. newlines) so a forged metadata value cannot
      // break out of the title prompt's "User: ..." line, then cap the length.
      const rawSkillName = ChatMessageMetadataSchema.safeParse(
        msgContent.metadata,
      ).data?.skill?.name;
      const skillName = truncateChars(
        collapseWhitespace(rawSkillName ?? ""),
        MAX_SKILL_NAME_LENGTH,
      );
      if (skillName) {
        firstUserSkillName = skillName;
      }
    }
    if (!firstUserMessage && msgContent.role === "user") {
      // Extract text from parts
      for (const part of msgContent.parts || []) {
        if (part.type === "text" && part.text) {
          firstUserMessage = part.text;
          break;
        }
      }
    }
    // Only a reply, i.e. an assistant message after the first user one. A chat
    // opened from an app is seeded before any user message with a render tool
    // call and a canned greeting ("Here's <App>. Want to change the app?");
    // that boilerplate is not a reply and must not become the title prompt's
    // assistant half.
    if (
      !firstAssistantMessage &&
      sawFirstUser &&
      msgContent.role === "assistant"
    ) {
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

  return { firstUserMessage, firstAssistantMessage, firstUserSkillName };
}

/**
 * Picks the user-intent string fed to title generation: the typed first message
 * when present, otherwise the invoked skill's name (a bare slash-command has no
 * typed text). Empty result means there is nothing to title from.
 */
export function resolveTitleUserInput(
  firstUserMessage: string,
  firstUserSkillName: string | null,
): string {
  return (
    firstUserMessage ||
    (firstUserSkillName ? `Skill: ${firstUserSkillName}` : "")
  );
}

export function buildChatStopConditions(repeatTracker: ToolCallRepeatTracker) {
  return [
    stepCountIs(MAX_AGENT_STEPS),
    repeatCeilingStopCondition(repeatTracker),
  ];
}

/**
 * Builds the prompt for title generation based on extracted messages.
 */
export function buildTitlePrompt(
  firstUserMessage: string,
  firstAssistantMessage: string,
): string {
  // By code point, so the cut cannot split a surrogate pair and send an
  // unpaired surrogate to the provider.
  const user = truncateChars(firstUserMessage, TITLE_PROMPT_EXCERPT_MAX_CHARS);
  const assistant = truncateChars(
    firstAssistantMessage,
    TITLE_PROMPT_EXCERPT_MAX_CHARS,
  );

  const contextMessages = assistant
    ? `User: ${user}\n\nAssistant: ${assistant}`
    : `User: ${user}`;

  return `Chat conversation messages:

${contextMessages}`;
}

/**
 * Parameters for generating a conversation title
 */
export interface GenerateTitleParams {
  provider: SupportedProvider;
  apiKey: string | undefined;
  modelName: string;
  baseUrl: string | null;
  /** Key row that supplied `apiKey` — forwarded so per-key proxy state (codex refresh-token rotation) binds to the right row. */
  chatApiKeyId?: string;
  agentId: string;
  userId: string;
  conversationId: string;
  systemPrompt: string;
  firstUserMessage: string;
  firstAssistantMessage: string;
}

/**
 * Reasoning models spend this budget on hidden thinking before writing anything
 * visible, so a tight cap is exhausted mid-thought and the call returns empty
 * text. Generous on purpose — it is a ceiling, not a reservation.
 */
const TITLE_MAX_OUTPUT_TOKENS = 4096;

/**
 * Enough of a message to name its topic. The opening turn can be a pasted log
 * or a long answer, and forwarding it whole makes the call slow and expensive
 * while giving the model more to answer rather than title.
 */
const TITLE_PROMPT_EXCERPT_MAX_CHARS = 1000;

/**
 * What each rejected title generation response means, said in full so an
 * operator reading the log does not have to know how title generation is
 * prompted to understand why a conversation kept its opening words.
 */
const TITLE_REJECTION_MESSAGES: Record<TitleRejectionReason, string> = {
  empty_response:
    "Title generation: the model wrote no visible text. A reasoning model can spend the entire output ceiling on hidden thinking and finish before writing a title. Falling back to the conversation's opening words.",
  not_a_title:
    "Title generation: the model answered the conversation instead of naming it — the response is far longer than a title can be. Discarding it and falling back to the conversation's opening words.",
};

/**
 * Generates a conversation title using the specified provider.
 *
 * Returns null when no title came back — the provider call failed, or it
 * answered with something {@link toConversationTitle} won't accept as a title.
 * Each case is logged with its cause here; the caller only needs to know it has
 * to fall back.
 */
export async function generateConversationTitle(
  params: GenerateTitleParams,
): Promise<string | null> {
  const {
    provider,
    apiKey,
    modelName,
    baseUrl,
    agentId,
    userId,
    conversationId,
    systemPrompt,
    firstUserMessage,
    firstAssistantMessage,
  } = params;

  const titlePrompt = buildTitlePrompt(firstUserMessage, firstAssistantMessage);

  logger.debug(
    { provider, modelName, hasApiKey: !!apiKey, baseUrl },
    "Title generation: creating logged LLM model",
  );

  const model = createLLMModel({
    provider,
    apiKey,
    agentId,
    modelName,
    userId,
    sessionId: conversationId,
    source: "chat:title_generation",
    baseUrl,
    chatApiKeyId: params.chatApiKeyId,
  });

  try {
    logger.debug(
      { provider, modelName },
      "Title generation: calling generateText",
    );
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: titlePrompt,
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
    });

    const outcome = toConversationTitle(result.text);

    if (outcome.title === null) {
      // Warn, not error: the provider answered, we just can't use what it said.
      // `finishReason: "length"` alongside an empty response is the reasoning
      // model case — it ran out of ceiling before writing anything visible.
      logger.warn(
        {
          provider,
          modelName,
          conversationId,
          rejectionReason: outcome.reason,
          finishReason: result.finishReason,
          responseChars: result.text.length,
        },
        TITLE_REJECTION_MESSAGES[outcome.reason],
      );
      return null;
    }

    logger.debug(
      { provider, modelName, conversationId, generatedTitle: outcome.title },
      "Title generation: the model returned a usable title",
    );
    return outcome.title;
  } catch (error) {
    logger.error(
      { error, provider, modelName, baseUrl, conversationId },
      "Title generation: the provider call failed. Falling back to the conversation's opening words.",
    );
    return null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Regenerate a turn: find the user message being regenerated, delete the stale
 * messages below it, and persist the freshly generated turn — atomically.
 *
 * The reads (what's stale, what's new) run first; the transaction then wraps
 * only the two writes, so they commit together. That is the point: nothing is
 * deleted unless the new turn is written in the same commit, so an interrupted
 * or failed regenerate can never leave the conversation with the old turn gone
 * and no replacement. Anchor and deletion are matched by id, never `createdAt`.
 *
 * @param requestMessages - the thread the client sent, ending at the user
 *   message being regenerated (the anchor)
 * @param finalMessages - the server-authoritative thread after generation
 */
async function persistRegeneratedTurn(params: {
  conversationId: string;
  requestMessages: unknown[];
  finalMessages: unknown[];
  /** Locked chats: the request-scoped browser-held key. */
  conversationKey?: ConversationContentKey | null;
}): Promise<void> {
  const { conversationId, requestMessages, finalMessages, conversationKey } =
    params;
  const existing = await MessageModel.findByConversation(
    conversationId,
    conversationKey,
  );

  // The user message being regenerated is the last one the client sent.
  // Everything stored below it is the stale turn to replace.
  const anchor = (requestMessages as ChatMessage[]).at(-1);
  const anchorIds = new Set(anchor ? getUiMessageIdentityIds(anchor) : []);
  const anchorIndex = existing.findIndex((row) =>
    storedMessageIds(row).some((id) => anchorIds.has(id)),
  );
  const staleIds =
    anchorIndex < 0 ? [] : existing.slice(anchorIndex + 1).map((row) => row.id);

  // The new turn is what the model just produced (not already stored).
  const newMessages = getMessagesNotYetPersisted({
    existingMessages: existing,
    uiMessages: finalMessages as ChatMessage[],
  });
  const now = Date.now();
  const newRows = normalizeChatMessagesForPersistence(newMessages).map(
    (msg, index) => ({
      conversationId,
      role: msg.role ?? "assistant",
      content: msg,
      createdAt: new Date(now + index),
    }),
  );

  await withDbTransaction(async (tx) => {
    await MessageModel.deleteByIds(staleIds, tx);
    await MessageModel.bulkCreate(newRows, tx, conversationKey);
  });

  logger.info(
    { conversationId, deleted: staleIds.length, persisted: newRows.length },
    "Regenerate: atomically replaced trailing turn",
  );
}

/** A stored row's identity: its primary key plus the AI SDK id in its content. */
function storedMessageIds(row: { id: string; content: unknown }): string[] {
  const contentId = getMessageContentId(row.content);
  return contentId ? [row.id, contentId] : [row.id];
}

/**
 * The turn's user-visible answer text: every text part of the assistant
 * message(s) after the last user message in the finalized thread. Built from
 * the persisted UI messages rather than streamText's `text`, which is only the
 * final step's text — a cited paragraph the model emitted before a later tool
 * step would otherwise never be checked.
 */
function extractTurnAnswerText(finalMessages: ChatMessage[]): string {
  const lastUserIndex = finalMessages.findLastIndex(
    (message) => message?.role === "user",
  );
  return finalMessages
    .slice(lastUserIndex + 1)
    .filter((message) => message?.role === "assistant")
    .flatMap((message) =>
      (message.parts ?? [])
        .filter(
          (part): part is { type: "text"; text: string } =>
            part?.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text),
    )
    .join("\n");
}

/**
 * Verifiable citations (issue #7161), the internal-chat half. Checks the
 * verbatim quotes the model tagged with a chunk ref against the chunks
 * `query_knowledge_sources` returned this turn (captured at tool-execution
 * time by chat-tool-builder — direct calls and `run_tool` dispatches alike).
 * Log-only: a quote found in no returned chunk is a fabrication surfaced to
 * logs and a metric, a quote behind an unresolvable ref is a mis-citation,
 * and neither is ever blocked or spliced into the answer. Only this surface
 * can do this — external MCP clients answer where Archestra cannot see the
 * text.
 */
function verifyChatCitedQuotes(params: {
  chunks: KbChunkForQuoteCheck[];
  answerText: string;
  conversationId: string;
  agentId: string;
}): void {
  const { chunks, answerText, conversationId, agentId } = params;

  // No knowledge was pulled this turn, so there is nothing to verify.
  if (chunks.length === 0) return;

  const result = verifyQuotes({
    answerText,
    chunks,
  });

  reportQuoteVerification({
    matched: result.matched,
    wrongRef: result.wrongRef.length,
    failed: result.failed.length,
    unverifiable: result.unverifiable.length,
    unparseable: result.unparseable ? 1 : 0,
  });

  if (result.failed.length > 0 || result.wrongRef.length > 0) {
    logger.warn(
      {
        conversationId,
        agentId,
        checked: result.checked,
        failedCount: result.failed.length,
        failedRefs: result.failed.map((quote) => quote.ref),
        wrongRefCount: result.wrongRef.length,
        wrongRefs: result.wrongRef.map((quote) => quote.ref),
      },
      "KB quote verification: cited quote(s) not backed by the cited chunk",
    );
  }
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
  conversationKey?: ConversationContentKey | null,
): Promise<number> {
  try {
    // Fetch existing messages to classify incoming ones as new or changed
    const existingMessages = await MessageModel.findByConversation(
      conversationId,
      conversationKey,
    );
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
        // Strip base64 images / large tool results and drop assistant turns left
        // non-renderable (e.g. only a dangling tool call, an unpaired MCP-app
        // marker, or empty/telemetry-only parts) — persisting one of those
        // yields a stuck-looking empty bubble on reload.
        const messagesToStore =
          normalizeChatMessagesForPersistence(messagesToSave);

        if (context === "onFinish") {
          // Log size reduction only for onFinish (where we have complete messages)
          const beforeSize = estimateMessagesSize(messagesToSave);
          const afterSize = estimateMessagesSize(messagesToStore);

          logger.info(
            {
              messageCount: messagesToStore.length,
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

        if (messagesToStore.length > 0) {
          const now = Date.now();
          const messageData = messagesToStore.map((msg, index) => ({
            conversationId,
            role: msg.role ?? "assistant",
            content: msg,
            createdAt: new Date(now + index),
          }));

          await MessageModel.bulkCreate(messageData, db, conversationKey);
          persistedCount += messagesToStore.length;

          logger.info(
            `Appended ${messagesToStore.length} new messages to conversation ${conversationId} (${context})`,
          );
        }
      }
    }

    // Persist content updates for messages that already exist but changed
    // (e.g. an assistant turn whose tool call was approved or declined).
    for (const changedMessage of changedMessages) {
      await MessageModel.updateContent(
        changedMessage.id,
        changedMessage.content,
        conversationKey,
      );
    }

    if (changedMessages.length > 0) {
      logger.info(
        `Updated ${changedMessages.length} changed messages in conversation ${conversationId} (${context})`,
      );
    }

    // Tell the owner's sidebar that activity landed so its new-messages
    // indicator refreshes — covers the case where the client navigated away
    // before the turn finished and so never saw the stream's onFinish. A
    // content-only change (persistedCount 0) still counts: a tool call's final
    // output can land in an existing assistant message.
    if (persistedCount > 0 || changedMessages.length > 0) {
      const owner = await ConversationModel.getOwner(conversationId);
      if (owner) {
        broadcastConversationUpdated(
          owner.userId,
          owner.organizationId,
          conversationId,
        );
      }
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
  lockedChatAudit?: LockedChatAuditContext | null;
}) {
  const chatError = getSerializableChatError(params.error);

  void ConversationChatErrorModel.create(
    {
      conversationId: params.conversationId,
      error: chatError,
    },
    params.lockedChatAudit,
  ).catch((error) => {
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

/**
 * The persisted form of a chat error for a locked chat: keep the
 * structured code, retryability, and trace correlation ids, but drop the
 * free-text `message` and the provider's `originalError` — both routinely echo
 * prompt/model content (provider 4xx bodies quote the request).
 */
function redactChatErrorForLockedChat(
  error: ChatErrorResponse,
): ChatErrorResponse {
  return {
    code: error.code,
    message: "Error details are redacted for locked chats.",
    isRetryable: error.isRetryable,
    ...(error.sessionId ? { sessionId: error.sessionId } : {}),
    ...(error.traceId ? { traceId: error.traceId } : {}),
    ...(error.spanId ? { spanId: error.spanId } : {}),
    ...(error.usageLimitExceeded !== undefined
      ? { usageLimitExceeded: error.usageLimitExceeded }
      : {}),
    ...(error.usageLimitEntityType
      ? { usageLimitEntityType: error.usageLimitEntityType }
      : {}),
    ...(error.authAction ? { authAction: error.authAction } : {}),
  };
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
    // ids. Track both forms so follow-up turns do not get dropped just because
    // the incoming thread is shorter than the DB thread.
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
      canReadOthersViaProject: () =>
        userHasPermission(
          params.userId,
          params.organizationId,
          "project",
          "read-all",
        ),
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

  // A chat started from a (shared) chat in a project belongs to that project,
  // just like one started from the project composer. Carry the source's
  // project over to the fork — but only when the forker can still access it.
  // Conversation shares are independent of project shares, so a conversation
  // can be shared without its project being shared; in that case drop the link
  // rather than attaching the fork to a project the user cannot see (which
  // would leave it invisible and unmanageable to them).
  let projectId: string | null = null;
  if (params.sourceConversation.projectId) {
    const project = await ProjectModel.findById(
      params.sourceConversation.projectId,
    );
    if (
      project &&
      (await ProjectShareModel.userCanAccessProject({
        project,
        userId: params.userId,
        organizationId: params.organizationId,
      }))
    ) {
      projectId = project.id;
    }
  }

  const newConversation = await ConversationModel.create({
    userId: params.userId,
    organizationId: params.organizationId,
    agentId: agent.id,
    modelId: params.sourceConversation.modelId,
    projectId,
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
        content: stripFeedbackMetadata(message),
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
 * A fork starts unrated: the source read projection embeds the owner's
 * feedback in message metadata, and persisting that copy verbatim would bake
 * a stale verdict into the fork's content JSON (its feedback column is NULL).
 */
function stripFeedbackMetadata(message: ChatMessage): ChatMessage {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || !("feedback" in metadata)) {
    return message;
  }
  const { feedback: _feedback, ...rest } = metadata as Record<string, unknown>;
  return { ...message, metadata: rest } as ChatMessage;
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
};

export default chatRoutes;
