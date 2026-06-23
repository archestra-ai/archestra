import crypto from "node:crypto";
import {
  type InteractionSource,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@archestra/shared";
import type { ModelMessage, UIMessage, UserContent } from "ai";
import {
  consumeStream as consumeReadableStream,
  NoOutputGeneratedError,
  stepCountIs,
  type streamText,
} from "ai";
import { MAX_AGENT_STEPS, runAgentStream } from "@/agents/agent-run-stream";
import { buildAgentSystemPrompt } from "@/agents/agent-system-prompt";
import { MIN_IMAGE_ATTACHMENT_SIZE } from "@/agents/incoming-email/constants";
import { subagentExecutionTracker } from "@/agents/subagent-execution-tracker";
import { closeChatMcpClient, getChatMcpTools } from "@/clients/chat-mcp-client";
import { createLLMModelForAgent } from "@/clients/llm-client";
import mcpClient from "@/clients/mcp-client";
import {
  REPEAT_CALL_TERMINATION_NOTICE,
  repeatCeilingStopCondition,
  ToolCallRepeatTracker,
} from "@/clients/tool-call-repeat-tracker";
import logger from "@/logging";
import { AgentModel, McpServerModel } from "@/models";
import {
  formatUnavailableToolErrorDetails,
  getUnavailableToolErrorDetails,
  mapProviderError,
  ProviderError,
} from "@/routes/chat/errors";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";

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
  /** Schedule trigger run ID — enables artifact_write to target the run */
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
    const { model } = await createLLMModelForAgent({
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

    // Build multimodal user content when image attachments are present
    const { content: userContent, skippedNote } = buildUserContent(
      message,
      attachments,
    );

    // Execute via the shared agent-run primitive: it owns the streamText call
    // and transparently recovers empty/abortive/context-length turns before any
    // result is collected. We stream internally but collect the full result.
    // Behavior change: A2A (and its scheduled/email/ChatOps/delegation callers)
    // previously had no recovery — a clean-but-empty turn returned an empty
    // success. It now retries and, on exhaustion, throws (mapped to a
    // ProviderError below), matching the interactive chat path.
    // Prefer the explicit `messages` param; otherwise use a `messages` user turn
    // when images are present, falling back to a plain `prompt` for text only.
    const baseConfig = {
      model,
      system: systemPrompt,
      tools: mcpTools,
      stopWhen: [
        stepCountIs(MAX_AGENT_STEPS),
        repeatCeilingStopCondition(repeatTracker),
      ],
      abortSignal,
    };
    const config: Parameters<typeof streamText>[0] =
      params.messages !== undefined
        ? { ...baseConfig, messages: params.messages }
        : userContent
          ? {
              ...baseConfig,
              messages: [{ role: "user" as const, content: userContent }],
            }
          : { ...baseConfig, prompt: message + skippedNote };

    let finalText: string;
    let usage: Awaited<ReturnType<typeof streamText>["usage"]>;
    let finishReason: Awaited<ReturnType<typeof streamText>["finishReason"]>;
    let responseUiMessage: UIMessage | undefined;
    // Captures the committed attempt's stream-level error (e.g. API billing
    // errors) so a generic NoOutputGeneratedError can surface the real cause.
    let getCapturedStreamError: () => unknown = () => undefined;
    try {
      const runStream = await runAgentStream({
        config,
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

      // The repeat-call ceiling stops the loop on a tool-call step, so the model
      // never took a turn to produce assistant text and `finalText` is empty.
      // Headless callers read only `text`, so surface why the run ended.
      if (
        finalText.trim() === "" &&
        repeatTracker.hasReachedTerminationCeiling()
      ) {
        finalText = REPEAT_CALL_TERMINATION_NOTICE;
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

/**
 * Build AI SDK UserContent from a text message and optional attachments.
 * Returns `content: null` when there are no image attachments (caller should use plain `prompt` instead).
 * Returns `skippedNote` with a human-readable note about non-image attachments that were dropped,
 * so the caller can append it to the prompt for the LLM to mention.
 *
 * Only image attachments are currently supported as inline content parts.
 * Non-image attachments are noted so the LLM can inform the user.
 * @public — exported for testability
 */
export function buildUserContent(
  message: string,
  attachments?: A2AAttachment[],
): { content: UserContent | null; skippedNote: string } {
  const allAttachments = attachments ?? [];

  // Split into image and non-image attachments
  const imageAttachments = allAttachments.filter((a) =>
    a.contentType.startsWith("image/"),
  );
  const nonImageAttachments = allAttachments.filter(
    (a) => !a.contentType.startsWith("image/"),
  );

  // Filter out tiny images (broken inline references from email replies).
  // Estimate actual byte size from base64 length: every 4 base64 chars = 3 bytes.
  const validImageAttachments = imageAttachments.filter((a) => {
    const estimatedBytes = Math.ceil((a.contentBase64.length * 3) / 4);
    return estimatedBytes >= MIN_IMAGE_ATTACHMENT_SIZE;
  });
  const tinyImageAttachments = imageAttachments.filter((a) => {
    const estimatedBytes = Math.ceil((a.contentBase64.length * 3) / 4);
    return estimatedBytes < MIN_IMAGE_ATTACHMENT_SIZE;
  });

  if (tinyImageAttachments.length > 0) {
    logger.debug(
      {
        count: tinyImageAttachments.length,
        images: tinyImageAttachments.map((a) => ({
          name: a.name ?? "unnamed",
          contentType: a.contentType,
          estimatedBytes: Math.ceil((a.contentBase64.length * 3) / 4),
        })),
      },
      "Filtering out tiny image attachments (likely broken inline references from email replies)",
    );
  }

  if (nonImageAttachments.length > 0) {
    logger.debug(
      {
        skippedCount: nonImageAttachments.length,
        skippedTypes: nonImageAttachments.map(
          (a) => `${a.name ?? "unnamed"} (${a.contentType})`,
        ),
      },
      "Skipping non-image attachments in buildUserContent (only image/* is currently supported)",
    );
  }

  // Build a note about all skipped attachments so the LLM can mention them
  const allSkipped = [...nonImageAttachments, ...tinyImageAttachments];
  const skippedNote =
    allSkipped.length > 0
      ? `\n\n[Note: This message also included ${allSkipped.length} attachment(s) that could not be processed: ${allSkipped.map((a) => `${a.name ?? "unnamed"} (${a.contentType})`).join(", ")}]`
      : "";

  if (validImageAttachments.length === 0) {
    return { content: null, skippedNote };
  }

  return {
    content: [
      { type: "text" as const, text: message + skippedNote },
      ...validImageAttachments.map((a) => ({
        type: "file" as const,
        data: Buffer.from(a.contentBase64, "base64"),
        mediaType: a.contentType,
      })),
    ],
    skippedNote,
  };
}

// ============================================================================
// Internal helper functions
// ============================================================================

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
