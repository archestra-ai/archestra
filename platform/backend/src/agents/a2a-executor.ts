import crypto from "node:crypto";
import {
  type ChatUploadRejectionReason,
  chatUploadRejectionReason,
  getModelReadableMimeTypes,
  INLINE_TEXT_MAX_BYTES,
  type InteractionSource,
  isInlineableTextMimeType,
  PLAYWRIGHT_MCP_CATALOG_ID,
  type SupportedProvider,
} from "@archestra/shared";
import type { ModelMessage, UIMessage, UserContent } from "ai";
import {
  consumeStream as consumeReadableStream,
  convertToModelMessages,
  NoOutputGeneratedError,
  stepCountIs,
  type streamText,
} from "ai";
import { resolveAgentMaxOutputTokens } from "@/agents/agent-output-budget";
import { MAX_AGENT_STEPS, runAgentStream } from "@/agents/agent-run-stream";
import { buildAgentSystemPrompt } from "@/agents/agent-system-prompt";
import { DelegationLoopError } from "@/agents/errors";
import { MIN_IMAGE_ATTACHMENT_SIZE } from "@/agents/incoming-email/constants";
import { createStepContextGuard } from "@/agents/step-context-guard";
import { subagentExecutionTracker } from "@/agents/subagent-execution-tracker";
import { closeChatMcpClient, getChatMcpTools } from "@/clients/chat-mcp-client";
import { createLLMModelForAgent } from "@/clients/llm-client";
import mcpClient from "@/clients/mcp-client";
import type { SubagentToolStreamBridge } from "@/clients/subagent-tool-stream";
import {
  REPEAT_CALL_TERMINATION_NOTICE,
  repeatCeilingStopCondition,
  ToolCallRepeatTracker,
} from "@/clients/tool-call-repeat-tracker";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, McpServerModel, ModelModel } from "@/models";
import {
  formatUnavailableToolErrorDetails,
  getUnavailableToolErrorDetails,
  mapProviderError,
  ProviderError,
} from "@/routes/chat/errors";
import { prepareMessagesForProvider } from "@/routes/chat/normalization/prepare-for-provider";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import type { ChatMessage } from "@/types";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";
import {
  stripThinkingBlocks,
  THINKING_ONLY_NOTICE,
} from "@/utils/strip-thinking-blocks";
import {
  type StageResult,
  stageAttachmentsIntoSandbox,
} from "./a2a/stage-attachments";

/**
 * Source-agnostic attachment for A2A execution.
 * Callers (email, Slack, Teams, etc.) should transform their provider-specific
 * attachment types into this format before passing to executeA2AMessage.
 */
export interface A2AAttachment {
  /** MIME content type (e.g., 'image/png', 'application/pdf') */
  contentType: string;
  /** Base64-encoded content */
  contentBase64: string;
  /** Optional filename for context */
  name?: string;
}

/**
 * Longest delegation chain (root agent + delegated descendants) allowed before
 * a further hop is refused. Mirrors MAX_AGENT_STEPS: a named constant, not
 * configuration.
 * @public exported for tests; used internally otherwise.
 */
export const MAX_DELEGATION_DEPTH = 5;

/** @public — exported for testability */
export interface A2AExecuteParams {
  /**
   * Agent ID to execute. Must be an internal agent (agentType='agent').
   */
  agentId: string;

  /**
   * When provided, it's used as parameter in streamText(...).
   * "message" param is ignored in this case.
   */
  messages?: ModelMessage[];

  /**
   * Legacy param, that is converted to messages: [{ role: "user", content: message }]
   *   in streamText(...) call.
   * It's not used when "messages" param is provided.
   */
  message: string;

  organizationId: string;
  userId: string;
  /** Session ID to group related LLM requests together in logs */
  sessionId?: string;
  /** Interaction source for tracking request origin in logs */
  source?: InteractionSource;
  /**
   * Parent delegation chain (colon-separated agent IDs).
   * The current agentId will be appended to form the new chain.
   */
  parentDelegationChain?: string;
  /**
   * Id of a persisted `conversations` row, when the execution belongs to one
   * (chat delegation). Tools may persist it as a foreign key — never pass a
   * synthetic id here. When absent, the execution is headless and an isolation
   * key scopes its per-execution state instead.
   */
  conversationId?: string;
  /**
   * Isolation scope inherited from the parent execution (headless
   * delegation), so sub-agents share the parent's browser tab tracking and
   * per-execution sandbox. When neither this nor `conversationId` is
   * provided (root headless call), a unique key is generated and its state is
   * cleaned up after execution.
   */
  isolationKey?: string;
  /** Optional cancellation signal propagated from parent chat/tool execution */
  abortSignal?: AbortSignal;
  /** Optional attachments to include in the message (e.g., images from email, Slack, Teams) */
  attachments?: A2AAttachment[];
  /** ChatOps channel binding ID for Slack/MS Teams-triggered executions */
  chatOpsBindingId?: string;
  /** ChatOps thread identifier for thread-scoped agent overrides */
  chatOpsThreadId?: string;
  /** Whether the parent execution context was still trusted at delegation time */
  parentContextIsTrusted?: boolean;
  /** Schedule trigger run ID — identifies the scheduled run this execution belongs to */
  scheduleTriggerRunId?: string;

  /** Whether to block execution when an approval-required tool is called (defaults to true) */
  blockOnApprovalRequired?: boolean;

  /**
   * History of UI messages needed for persistance at new UIMessage generation
   * Without it stream.toUIMessageStream(...)
   *    throws AI_UIMessageStreamError:tool-invocation error
   *    in case of tool invocation approval.
   */
  originalUiMessages?: UIMessage[];

  /**
   * When set (chat delegation), the child's tool calls are surfaced on the
   * caller's conversation through this bridge, attributed to
   * `delegationToolCallId`, and the bridge is forwarded into the child's own
   * tools so deeper descendants surface too. Absent in headless executions.
   */
  subagentToolStream?: SubagentToolStreamBridge;
  /**
   * The id of the delegation tool call (`agent__<slug>`) that invoked this
   * agent. The child's surfaced tool calls hang under it. Set together with
   * `subagentToolStream`.
   */
  delegationToolCallId?: string;
}

/** @public — exported for testability */
export interface A2AExecuteResult {
  messageId: string;
  text: string;
  finishReason: string;
  responseUiMessage: UIMessage;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Execute a message against an A2A agent (internal agent with prompts)
 * This is the shared execution logic used by both A2A routes and dynamic agent tools
 */
export async function executeA2AMessage(
  params: A2AExecuteParams,
): Promise<A2AExecuteResult> {
  const {
    agentId,
    message,
    organizationId,
    userId,
    sessionId,
    source,
    parentDelegationChain,
    abortSignal,
    attachments,
    chatOpsBindingId,
    chatOpsThreadId,
    parentContextIsTrusted,
    scheduleTriggerRunId,
    subagentToolStream,
    delegationToolCallId,
  } = params;

  // Isolation key scoping per-execution state (browser tabs, MCP client
  // cache, headless sandboxes). Chat delegation provides the conversation id;
  // headless delegation inherits the parent execution's key; a root headless
  // call generates one and cleans its state up after execution. Only
  // `params.conversationId` may ever be persisted as a conversation id.
  const isDirectExecutionOutsideConversation =
    !params.conversationId && !params.isolationKey;
  const isolationKey =
    params.conversationId ?? params.isolationKey ?? crypto.randomUUID();

  // Build delegation chain: append current agentId to parent chain
  const delegationChain = parentDelegationChain
    ? `${parentDelegationChain}:${agentId}`
    : agentId;

  // The parent chain is this run's ancestor path, so re-entering an agent
  // already on it is a delegation cycle that would recurse until the LLM budget
  // runs out. Both existing loop guards are per-run (a fresh step budget and a
  // fresh repeat tracker per delegation), so neither sees it. Refuse before any
  // I/O; `handleDelegation` turns the throw into a tool error the model can
  // recover from. Agent ids are uuids, so ":" cannot appear inside one.
  const ancestors = parentDelegationChain?.split(":") ?? [];
  if (ancestors.includes(agentId)) {
    throw new DelegationLoopError(
      "That agent is already in the current delegation chain. Answer directly instead of delegating back to it.",
    );
  }
  if (ancestors.length + 1 > MAX_DELEGATION_DEPTH) {
    throw new DelegationLoopError(
      `Delegation depth limit of ${MAX_DELEGATION_DEPTH} reached. Answer directly instead of delegating further.`,
    );
  }

  // Fetch the internal agent
  const agent = await AgentModel.findById(agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  // Verify agent is internal (has prompts)
  if (agent.agentType !== "agent") {
    throw new Error(
      `Agent ${agentId} is not an internal agent (A2A requires agents with agentType='agent')`,
    );
  }

  const { selectedModel, selectedProvider: provider } =
    await resolveConversationLlmSelectionForAgent({
      agent: {
        llmApiKeyId: agent.llmApiKeyId,
        modelId: agent.modelId,
      },
      organizationId,
      userId,
      // A2A runs (chatops, scheduled triggers, external A2A, delegation) are not
      // the user driving the /chat model selector, so they resolve from the
      // agent's own configuration rather than the caller's personal chat default.
      includeMemberChatDefault: false,
    });

  // Track subagent execution so the browser preview can skip screenshots
  // while subagents are active (prevents flickering from tab switching).
  // Only track delegated calls — direct A2A calls have no browser preview.
  if (!isDirectExecutionOutsideConversation) {
    subagentExecutionTracker.increment(isolationKey);
  }

  try {
    // One tracker per run, shared between the breaker (records each call) and the
    // stop condition below (terminates the run once repeats hit the ceiling).
    const repeatTracker = new ToolCallRepeatTracker();

    // Fetch MCP tools for the agent (including delegation tools)
    // Pass sessionId, delegationChain, and isolationKey for browser tab isolation
    const mcpTools = await getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId,
      organizationId,
      chatOpsBindingId,
      chatOpsThreadId,
      sessionId,
      delegationChain,
      conversationId: params.conversationId,
      isolationKey,
      abortSignal,
      blockOnApprovalRequired: params.blockOnApprovalRequired ?? true,
      scheduleTriggerRunId,
      // Forward the same bridge so a nested delegation's tool calls surface too,
      // attributed to the nested delegation call (recursion through the chain).
      subagentToolStream,
      repeatTracker,
    });

    const systemPrompt = await buildAgentSystemPrompt({
      agent,
      mcpTools,
      organizationId,
      userId,
      agentId: agent.id,
    });

    logger.info(
      {
        agentId: agent.id,
        userId,
        orgId: organizationId,
        toolCount: Object.keys(mcpTools).length,
        model: selectedModel,
        hasSystemPrompt: !!agent.systemPrompt,
        isolationKey,
        isDirectExecutionOutsideConversation,
      },
      "Starting A2A execution",
    );

    // Create LLM model using shared service
    // Pass sessionId to group A2A requests with the calling session
    // Pass delegationChain as externalAgentId so agent names appear in logs
    // Pass agent's llmApiKeyId so it can be used without user access check
    const { model, anthropicNativeEndpoint } = await createLLMModelForAgent({
      organizationId,
      userId,
      agentId: agent.id,
      model: selectedModel,
      provider,
      sessionId,
      source,
      externalAgentId: delegationChain,
      agentLlmApiKeyId: agent.llmApiKeyId,
      contextIsTrusted: parentContextIsTrusted,
    });

    // Which attachment mime types this model can read. A missing model row
    // (lookup failure or unknown model) falls back to the safe default set
    // (text + images + PDF) rather than dropping everything.
    const modelRow = await ModelModel.findByProviderAndModelId(
      provider,
      selectedModel,
    ).catch(() => null);
    const ingestibleMimeTypes = getModelReadableMimeTypes(
      modelRow?.inputModalities ?? null,
    );

    // A file the model cannot read inline is staged into the agent's sandbox when
    // one is usable for this caller. Resolved only when there are attachments, so
    // text-only turns (the common case) skip the permission/DB chain. Skip the
    // lookup for the synthetic "system" actor (external A2A v2) — it can never
    // hold `sandbox:execute`.
    const sandboxAvailable =
      (attachments?.length ?? 0) > 0 && userId && userId !== "system"
        ? await isSkillSandboxAvailableForAgent({
            userId,
            organizationId,
            agentId,
          })
        : false;

    // Build the current user turn from the message + attachments, gated by the
    // model's capabilities and normalized for the provider. `params.messages`
    // carries only prior context; this turn is appended to it below. Passing
    // `stageAttachments` is what tells `buildUserContent` a sandbox is available.
    const { content: userContent, note } = await buildUserContent(
      message,
      attachments,
      {
        provider,
        anthropicNativeEndpoint,
        ingestibleMimeTypes,
        sandboxByteLimit: config.skillsSandbox.artifactBytesLimit,
        stageAttachments: sandboxAvailable
          ? (atts) =>
              stageAttachmentsIntoSandbox({
                attachments: atts,
                organizationId,
                userId,
                conversationId: params.conversationId ?? null,
                isolationKey,
                agentId,
              })
          : undefined,
      },
    );
    const currentTurnText = message + note;

    // Execute via the shared agent-run primitive: it owns the streamText call
    // and transparently recovers empty/abortive/context-length turns before any
    // result is collected. We stream internally but collect the full result.
    // Behavior change: A2A (and its scheduled/email/ChatOps/delegation callers)
    // previously had no recovery — a clean-but-empty turn returned an empty
    // success. It now retries and, on exhaustion, throws (mapped to a
    // ProviderError below), matching the interactive chat path.
    // The executor owns the current user turn: `params.messages` (when present)
    // is prior context only, and the turn built from `message`/`attachments` is
    // appended to it. When there is no current turn (e.g. an approval-decision
    // message with no text or attachments), the context is used as-is. Callers
    // without context (delegation, scheduled, A2A v1) fall back to a plain
    // `prompt` for text, or a single `messages` turn when attachments survive.
    const baseConfig = {
      model,
      system: systemPrompt,
      tools: mcpTools,
      stopWhen: [
        stepCountIs(MAX_AGENT_STEPS),
        repeatCeilingStopCondition(repeatTracker),
      ],
      abortSignal,
      // Request the model's real output ceiling (clamped by the operator
      // ceiling), or a safe fallback when unknown. Without this, providers that
      // inject a small default max (e.g. Anthropic's ~4096) truncated large
      // tool-call payloads.
      maxOutputTokens: resolveAgentMaxOutputTokens({
        outputLength: modelRow?.outputLength ?? null,
        ceiling: config.chat.maxOutputTokensCeiling,
      }),
      // Per-step context guard: cap oversized tool results and keep the
      // accumulated step history inside the model's context window, compacting
      // the older prefix into an LLM summary when it overflows. Overrides only
      // what each step sends to the model — the loop's own state (and the
      // persisted/streamed UIMessage) keeps the full tool outputs.
      prepareStep: createStepContextGuard({
        model,
        contextLength: modelRow?.contextLength ?? null,
        systemPrompt,
        abortSignal,
        logContext: { agentId: agent.id, sessionId },
      }),
    };
    const currentTurn: { role: "user"; content: UserContent } | null =
      userContent !== null
        ? { role: "user", content: userContent }
        : currentTurnText.trim().length > 0
          ? { role: "user", content: currentTurnText }
          : null;
    const streamConfig: Parameters<typeof streamText>[0] =
      params.messages !== undefined
        ? {
            ...baseConfig,
            messages: currentTurn
              ? [...params.messages, currentTurn]
              : params.messages,
          }
        : currentTurn
          ? { ...baseConfig, messages: [currentTurn] }
          : { ...baseConfig, prompt: currentTurnText };

    let finalText: string;
    let usage: Awaited<ReturnType<typeof streamText>["usage"]>;
    let finishReason: Awaited<ReturnType<typeof streamText>["finishReason"]>;
    let responseUiMessage: UIMessage | undefined;
    // Captures the committed attempt's stream-level error (e.g. API billing
    // errors) so a generic NoOutputGeneratedError can surface the real cause.
    let getCapturedStreamError: () => unknown = () => undefined;
    try {
      const runStream = await runAgentStream({
        config: streamConfig,
        recovery: { logContext: { agentId: agent.id, sessionId } },
      });
      const stream = runStream.result;
      getCapturedStreamError = runStream.getCapturedStreamError;

      const uiMessageStreamConsumption = consumeReadableStream({
        stream: stream.toUIMessageStream<UIMessage>({
          originalMessages: params.originalUiMessages,
          generateMessageId: () => crypto.randomUUID(),
          onFinish: ({ responseMessage }) => {
            responseUiMessage = responseMessage;
          },
          onError: (error) => {
            // a nonexistent-tool call is recoverable: the SDK already feeds the
            // tool-error back to the model and continues the loop, so return the
            // recovery text as the part's errorText instead of killing the run
            const unavailableToolError = getUnavailableToolErrorDetails(error);
            if (unavailableToolError) {
              logger.info(
                { agentId: agent.id, unavailableToolError },
                "Returning unavailable tool error as tool-level error in A2A execution",
              );
              return formatUnavailableToolErrorDetails(unavailableToolError);
            }
            logger.error(
              { agentId: agent.id, error },
              "Error stream.toUIMessageStream when parsing A2A execution response",
            );
            throw error;
          },
        }),
        onError: (error) => {
          logger.error(
            { agentId: agent.id, error },
            "Error consuming UI message stream for A2A execution response",
          );
          throw error;
        },
      });

      // Wait for the stream to complete and get the final text.
      // When the underlying provider returns an error (e.g. 400 insufficient
      // credits), the stream produces zero steps and the AI SDK throws
      // NoOutputGeneratedError.  Re-throw with the real error message so callers
      // (and ultimately end-users) see what actually went wrong.
      [finalText, usage, finishReason] = await Promise.all([
        stream.text,
        stream.usage,
        stream.finishReason,
        uiMessageStreamConsumption,
      ]);

      if (!responseUiMessage) {
        // This should never happen
        throw new Error(
          "A2A execution failed: no response UIMessage generated",
        );
      }

      // Strip inline `<thinking>...</thinking>` text from the model's output at
      // this single A2A boundary, so every consumer (protocol reply, delegation
      // tool result, email, scheduled-run persistence) shares the invariant.
      // Text parts are stripped in place — an emptied part is kept (not removed)
      // so a thinking-only turn never collapses to a zero-part assistant message,
      // which some providers reject when the persisted history is replayed.
      // Structured `reasoning` parts are left untouched: the A2A protocol reply
      // excludes them (only text parts survive), and where they are surfaced
      // (the scheduled-run chat view) they render via the chat's reasoning UI,
      // exactly as interactive chat does — stripping them is out of scope here.
      const hadTextBeforeStrip = finalText.trim() !== "";
      finalText = stripThinkingBlocks(finalText);
      for (const part of responseUiMessage.parts) {
        if (part.type === "text") {
          part.text = stripThinkingBlocks(part.text);
        }
      }

      // Surface this run's tool calls on the caller's conversation, attributed
      // to the delegation call that invoked this agent. Nested delegations'
      // tool calls are emitted by their own runs (which share this bridge), so
      // the whole chain surfaces. The delegation tool's result is unaffected —
      // it stays the child's final text.
      if (subagentToolStream && delegationToolCallId) {
        emitSubagentToolCalls({
          bridge: subagentToolStream,
          parentToolCallId: delegationToolCallId,
          message: responseUiMessage,
        });
      }

      // The repeat-call ceiling stops the loop on a tool-call step, so the model
      // never took a turn to produce assistant text and `finalText` is empty.
      // Headless callers read only `text`, so surface why the run ended.
      if (
        finalText.trim() === "" &&
        repeatTracker.hasReachedTerminationCeiling()
      ) {
        finalText = REPEAT_CALL_TERMINATION_NOTICE;
      } else if (hadTextBeforeStrip && finalText.trim() === "") {
        // The whole textual answer was `<thinking>` and stripped to nothing.
        // Substitute the notice in both the headless `text` and the message so
        // the protocol reply / persistence (built from text parts) carries it.
        finalText = THINKING_ONLY_NOTICE;
        const firstTextPart = responseUiMessage.parts.find(
          (p) => p.type === "text",
        );
        if (firstTextPart?.type === "text") {
          firstTextPart.text = THINKING_ONLY_NOTICE;
        } else {
          responseUiMessage.parts.push({
            type: "text",
            text: THINKING_ONLY_NOTICE,
          });
        }
      }
    } catch (streamError) {
      const capturedStreamError = getCapturedStreamError();
      if (
        NoOutputGeneratedError.isInstance(streamError) &&
        capturedStreamError !== undefined
      ) {
        throw new ProviderError(
          mapProviderError(capturedStreamError, provider),
        );
      }
      throw new ProviderError(mapProviderError(streamError, provider));
    }

    logger.info(
      {
        agentId: agent.id,
        provider,
        finishReason,
        usage,
        messageId: responseUiMessage.id,
      },
      "A2A execution finished",
    );

    return {
      messageId: responseUiMessage.id,
      text: finalText,
      finishReason: finishReason ?? "unknown",
      responseUiMessage,
      usage: usage
        ? {
            promptTokens: usage.inputTokens ?? 0,
            completionTokens: usage.outputTokens ?? 0,
            totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          }
        : undefined,
    };
  } finally {
    // Clean up browser tab BEFORE decrementing the tracker.
    // This ensures screenshots remain paused while the subagent's tab is
    // being closed, preventing the preview from capturing the wrong tab.
    await cleanupBrowserTab({
      agentId,
      userId,
      organizationId,
      isolationKey,
      isDirectExecutionOutsideConversation,
    });

    if (!isDirectExecutionOutsideConversation) {
      subagentExecutionTracker.decrement(isolationKey);
    }

    // The root headless execution owns its generated isolation scope; drop the
    // per-execution sandbox state once the run (and its delegations) finished.
    if (isDirectExecutionOutsideConversation) {
      executionSandboxRegistry.release(isolationKey);
    }
  }
}

// ============================================================================
// Exported helper functions
// ============================================================================

/** Stages raw (non-DB) attachments into the agent's per-execution sandbox. */
type StageAttachmentsFn = (
  attachments: A2AAttachment[],
) => Promise<StageResult[]>;

/**
 * Emit one `data-subagent-tool-call` per tool part in a child run's final
 * message, attributed to the delegation call that invoked the child. The bridge
 * caps payloads and streams/collects each call. Skips non-tool parts (text,
 * reasoning, step markers). A nested delegation call (`agent__<slug>`) is itself
 * a tool part, so it surfaces here while its own children surface from the
 * nested run — the client re-nests them by id.
 * @public — exported for testability
 */
export function emitSubagentToolCalls(params: {
  bridge: SubagentToolStreamBridge;
  parentToolCallId: string;
  message: UIMessage;
}): void {
  const { bridge, parentToolCallId, message } = params;
  type ToolPart = {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    state?: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };
  // Collapse to one entry per toolCallId, last-wins: a UIMessage normally holds
  // a single part per tool call in its terminal state, but if an earlier
  // (input-available) part and a later (output-available) part for the same id
  // both appear, the later terminal one must win so the surfaced card shows the
  // result/error rather than a perpetually-pending call.
  const byCallId = new Map<string, ToolPart>();
  for (const rawPart of message.parts ?? []) {
    const part = rawPart as ToolPart;
    const type = part.type;
    if (typeof type !== "string") {
      continue;
    }
    const isToolPart = type.startsWith("tool-") || type === "dynamic-tool";
    if (!isToolPart || typeof part.toolCallId !== "string") {
      continue;
    }
    byCallId.set(part.toolCallId, part);
  }

  for (const [toolCallId, part] of byCallId) {
    const type = part.type as string;
    const toolName =
      type === "dynamic-tool"
        ? (part.toolName ?? "unknown")
        : type.slice("tool-".length);
    bridge.emit({
      parentToolCallId,
      toolCallId,
      toolName,
      ...(part.input !== undefined ? { input: part.input } : {}),
      ...(part.state !== undefined ? { state: part.state } : {}),
      ...(part.output !== undefined ? { output: part.output } : {}),
      ...(part.errorText !== undefined ? { errorText: part.errorText } : {}),
    });
  }
}

/**
 * Build the current user turn's AI SDK content from a text message and optional
 * attachments, mirroring the chat-side attachment policy
 * (`chatUploadRejectionReason`):
 *   - images: kept inline, minus the tiny-broken-image filter;
 *   - inlineable text ≤ {@link INLINE_TEXT_MAX_BYTES}: kept inline (decoded per
 *     provider by `prepareMessagesForProvider`);
 *   - other model-ingestible types (PDF, audio, video): kept inline at any size;
 *   - anything else, when a sandbox is available and it fits the artifact limit:
 *     staged into the sandbox and referenced by a pointer in `note` so the model
 *     can read it with `run_command`;
 *   - the rest: named in `note` with the reason they could not be provided.
 *
 * Returns `content: null` when nothing survives inline, so the caller falls back
 * to a plain text turn carrying `note`.
 * @public — exported for testability
 */
export async function buildUserContent(
  message: string,
  attachments: A2AAttachment[] | undefined,
  opts: {
    provider: SupportedProvider;
    anthropicNativeEndpoint: boolean;
    ingestibleMimeTypes: Set<string>;
    sandboxByteLimit?: number;
    stageAttachments?: StageAttachmentsFn;
  },
): Promise<{ content: UserContent | null; note: string }> {
  // `A2AAttachment.contentType` is typed non-optional, but every value
  // originates from an external source (A2A protocol parts, chat-platform or
  // email uploads) and stays populated only because each ingestion path defaults
  // it — the A2A path in particular narrows an optional SDK `mediaType` through
  // an `as string` cast behind a co-located filter. Default a missing content
  // type once here so a slip at any of those sites can't crash the image/mime
  // classification below or emit a `data:undefined;base64,...` URL further down.
  const allAttachments = (attachments ?? []).map((att) =>
    att.contentType ? att : { ...att, contentType: "application/octet-stream" },
  );
  // A sandbox is usable iff the caller supplied a stager; deriving it here (vs a
  // separate flag) makes the "available but unstageable" state unrepresentable.
  const sandboxAvailable = opts.stageAttachments !== undefined;
  const sandboxByteLimit =
    opts.sandboxByteLimit ?? config.skillsSandbox.artifactBytesLimit;

  // Images are matched broadly by `image/*` and always kept (subject to the
  // tiny-broken-image filter), deliberately bypassing the mime classifier: a
  // model's readable set may omit a non-standard subtype (e.g. `image/jpg`) that
  // the provider still renders, so images are never staged or rejected here.
  const imageAttachments = allAttachments.filter((a) =>
    a.contentType.startsWith("image/"),
  );
  const nonImageAttachments = allAttachments.filter(
    (a) => !a.contentType.startsWith("image/"),
  );

  // Filter out tiny images (broken inline references from email replies).
  const validImageAttachments = imageAttachments.filter(
    (a) => estimateAttachmentBytes(a) >= MIN_IMAGE_ATTACHMENT_SIZE,
  );
  const tinyImageAttachments = imageAttachments.filter(
    (a) => estimateAttachmentBytes(a) < MIN_IMAGE_ATTACHMENT_SIZE,
  );

  // Classify each non-image attachment with the shared policy, then split the
  // accepted ones into inline-now vs stage-into-sandbox.
  const inlineNonImage: A2AAttachment[] = [];
  const toStage: A2AAttachment[] = [];
  const rejected: Array<{
    att: A2AAttachment;
    reason: ChatUploadRejectionReason;
  }> = [];
  for (const att of nonImageAttachments) {
    const reason = chatUploadRejectionReason({
      mimeType: att.contentType,
      byteLength: estimateAttachmentBytes(att),
      ingestibleMimeTypes: opts.ingestibleMimeTypes,
      sandboxAvailable,
      sandboxByteLimit,
    });
    if (reason) {
      rejected.push({ att, reason });
    } else if (canInlineAttachment(att, opts.ingestibleMimeTypes)) {
      inlineNonImage.push(att);
    } else {
      toStage.push(att);
    }
  }

  // Stage the sandbox-bound attachments. A creation/upload failure surfaces as a
  // note (no silent drop) and the turn continues with whatever else survived.
  const stagedPointers: Array<{ name: string; path: string }> = [];
  const stageFailed: A2AAttachment[] = [];
  if (toStage.length > 0) {
    const results = opts.stageAttachments
      ? await opts.stageAttachments(toStage)
      : toStage.map(() => ({ error: true as const }));
    results.forEach((result, i) => {
      if ("path" in result) {
        stagedPointers.push({
          name: toStage[i].name ?? "unnamed",
          path: result.path,
        });
      } else {
        stageFailed.push(toStage[i]);
      }
    });
  }

  const unprovidable = [
    ...tinyImageAttachments.map(describeAttachment),
    ...rejected.map(
      (r) => `${describeAttachment(r.att)} — ${rejectionText(r.reason)}`,
    ),
    ...stageFailed.map((a) => `${describeAttachment(a)} — could not be staged`),
  ];

  logger.debug(
    {
      inlined: validImageAttachments.length + inlineNonImage.length,
      staged: stagedPointers.length,
      rejected: rejected.length,
      tinyImages: tinyImageAttachments.length,
      stageFailed: stageFailed.length,
    },
    "[A2A] attachment policy outcome in buildUserContent",
  );

  let note = "";
  if (unprovidable.length > 0) {
    note += `\n\n[Note: This message also included ${unprovidable.length} attachment(s) that could not be processed: ${unprovidable.join(", ")}]`;
  }
  // Identical content dedupes to one upload (and one path) via `uploadFile`, so
  // collapse pointers by path to avoid naming the same staged file twice.
  const uniquePointers = [
    ...new Map(stagedPointers.map((p) => [p.path, p])).values(),
  ];
  if (uniquePointers.length > 0) {
    note += `\n\n[Note: ${uniquePointers.length} attachment(s) were placed in your sandbox: ${uniquePointers
      .map((p) => `"${p.name}" at ${p.path}`)
      .join(", ")}. Use the run_command tool to read or process them.]`;
  }

  const keptAttachments = [...validImageAttachments, ...inlineNonImage];
  if (keptAttachments.length === 0) {
    return { content: null, note };
  }

  // Hand the inline attachments to the chat provider-normalization pipeline as a
  // synthetic user message (data: URL file parts), so each provider's SDK
  // receives documents in the shape it accepts (Anthropic documents, decoded
  // text for OpenAI-compatible endpoints, etc.).
  const text = message + note;
  const userMessage: ChatMessage = {
    role: "user",
    parts: [
      ...(text.length > 0 ? [{ type: "text", text }] : []),
      ...keptAttachments.map((a) => ({
        type: "file",
        url: `data:${a.contentType};base64,${a.contentBase64}`,
        mediaType: a.contentType,
        filename: a.name,
      })),
    ],
  };

  const [preparedMessage] = prepareMessagesForProvider({
    messages: [userMessage],
    provider: opts.provider,
    anthropicNativeEndpoint: opts.anthropicNativeEndpoint,
  });
  const modelMessages = await convertToModelMessages([
    preparedMessage,
  ] as unknown as Omit<UIMessage, "id">[]);

  const content = (modelMessages[0]?.content ?? null) as UserContent | null;
  return { content, note };
}

// ============================================================================
// Internal helper functions
// ============================================================================

/** Estimate decoded byte size from base64 length: every 4 chars = 3 bytes. */
function estimateAttachmentBytes(att: A2AAttachment): number {
  return Math.ceil((att.contentBase64.length * 3) / 4);
}

function describeAttachment(att: A2AAttachment): string {
  return `${att.name ?? "unnamed"} (${att.contentType})`;
}

/**
 * Whether an accepted non-image attachment is delivered inline (vs staged):
 * small inlineable text, or a non-text type the model ingests natively.
 */
function canInlineAttachment(
  att: A2AAttachment,
  ingestibleMimeTypes: Set<string>,
): boolean {
  if (isInlineableTextMimeType(att.contentType)) {
    return estimateAttachmentBytes(att) <= INLINE_TEXT_MAX_BYTES;
  }
  return ingestibleMimeTypes.has(att.contentType);
}

function rejectionText(reason: ChatUploadRejectionReason): string {
  switch (reason) {
    case "text_too_large":
      return "text too large to inline";
    case "too_large_for_sandbox":
      return "exceeds the sandbox size limit";
    case "unsupported_type":
      return "type not supported by this model";
  }
}

/**
 * Clean up browser tab state after A2A execution.
 * Closes the browser tab and optionally the MCP client.
 */
async function cleanupBrowserTab(params: {
  agentId: string;
  userId: string;
  organizationId: string;
  isolationKey: string;
  isDirectExecutionOutsideConversation: boolean;
}): Promise<void> {
  const {
    agentId,
    userId,
    organizationId,
    isolationKey,
    isDirectExecutionOutsideConversation,
  } = params;

  try {
    // Close the browser tab via the feature service
    const { browserStreamFeature } = await import(
      "@/features/browser-stream/services/browser-stream.feature"
    );

    if (browserStreamFeature.isEnabled()) {
      await browserStreamFeature.closeTab(agentId, isolationKey, {
        userId,
        organizationId,
      });
    }
  } catch (error) {
    logger.warn(
      { agentId, userId, isolationKey, error },
      "Failed to close browser tab during A2A cleanup (non-fatal)",
    );
  }

  // Close the subagent's cached MCP session so the Playwright pod cleans up
  // the browser context. This is needed for both direct and delegated calls
  // since each (agentId, conversationId) gets its own session.
  try {
    const userServer = await McpServerModel.getUserPersonalServerForCatalog(
      userId,
      PLAYWRIGHT_MCP_CATALOG_ID,
    );
    if (userServer) {
      mcpClient.closeSession(
        PLAYWRIGHT_MCP_CATALOG_ID,
        userServer.id,
        agentId,
        isolationKey,
      );
    }
  } catch (error) {
    logger.warn(
      { agentId, userId, isolationKey, error },
      "Failed to close MCP session during A2A cleanup (non-fatal)",
    );
  }

  // Root executions own the MCP client, so close it to free the cache slot.
  // Delegated runs (chat or headless) share their parent's scope and keep the
  // client alive for reuse.
  if (isDirectExecutionOutsideConversation) {
    try {
      closeChatMcpClient(agentId, userId, isolationKey);
    } catch (error) {
      logger.warn(
        { agentId, userId, isolationKey, error },
        "Failed to close MCP client during A2A cleanup (non-fatal)",
      );
    }
  }
}
