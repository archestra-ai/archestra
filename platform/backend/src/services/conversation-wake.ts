import type { ChatMessage } from "@archestra/shared";
import { ChatErrorCode, QUIET_WAKE_SENTINEL } from "@archestra/shared";
import type { UIMessage } from "ai";
import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import {
  AgentModel,
  ConversationChatErrorModel,
  ConversationModel,
  MessageModel,
} from "@/models";
import ActiveChatRunModel from "@/models/chat-active-run";
import { ProviderError } from "@/routes/chat/errors";
import { normalizeChatMessages } from "@/routes/chat/normalization/normalize-chat-messages";
import { buildModelMessages } from "@/routes/chat/prepare-model-messages";
import { activeChatRunService } from "@/services/active-chat-run";
import { trackBackgroundWork } from "@/utils/background-work";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";
import {
  broadcastConversationUpdated,
  broadcastConversationWake,
} from "@/websocket";

/**
 * Wake delivery for chat conversations — the one path every harness event
 * (settled background task, scheduled wakeup, monitor) uses to hand control
 * back to the model.
 *
 * Delivery is two-phase:
 *  1. Persist the wake notification as a `user`-role message (marked via
 *     metadata) once the conversation is idle, then broadcast
 *     `conversation_wake`. A browser viewing the conversation resubmits the
 *     notification as an ordinary streaming turn — best UX, full streaming.
 *  2. If no turn starts within a short grace window (tab closed, conversation
 *     not open), run the wake turn HERE, headlessly: same active-run mutex as
 *     the interactive path (so a late browser submit gets the normal 409),
 *     the model answers via `executeA2AMessage` against the full prepared
 *     conversation history, and the reply is persisted like any other
 *     message. Results land with nobody watching.
 *
 * Locked chats are refused before anything is written: their message content
 * key exists only in the owner's browser, so a server-side write would
 * silently downgrade the conversation's encryption guarantee.
 */

interface ConversationWakeParams {
  conversationId: string;
  /**
   * Stable message content id (e.g. `bg-task-<taskId>`). Persistence checks
   * for it before writing, so a retried delivery never duplicates the
   * notification; the browser resubmit path carries the same id and the chat
   * route's own persistence dedups it too. Event-level exactly-once still
   * comes from ownership (task-settle wins, reaper rows, one run per trigger
   * fire) — the id check is the crash-retry backstop.
   */
  messageId: string;
  text: string;
  metadata: Record<string, unknown>;
  /** Broadcast scoping fallback when the owner lookup comes up empty. */
  fallbackUserId?: string | null;
  /**
   * Monitor-mode wake: when the headless reply leads with the no-change
   * sentinel, the reply is stamped `quietWake` (the pair collapses in the
   * UI) and the conversation is not left unread. A browser-claimed turn
   * renders normally — the user was watching anyway.
   */
  quiet?: boolean;
}

class ConversationWakeService {
  /**
   * Timing knobs, on the instance so tests can shrink them. Production code
   * never mutates these.
   */
  timings = {
    idlePollMs: 750,
    idleWaitDeadlineMs: 15 * 60_000,
    /** How long the browser gets to claim the wake turn before we run it. */
    headlessGraceMs: 10_000,
    headlessGracePollMs: 1_000,
    /**
     * Liveness cadence for headless runs. The active-run reaper fails
     * `running` rows untouched for 10 minutes; touching once a minute keeps
     * a long headless turn alive with a wide margin.
     */
    headlessLivenessIntervalMs: 60_000,
  };

  /**
   * Persist the wake notification and make sure a wake turn runs: browser
   * first (streaming UX), headless fallback when nobody picks it up.
   * Returns false when delivery was refused (deleted or locked conversation).
   */
  async deliver(params: ConversationWakeParams): Promise<boolean> {
    if (!(await this.checkDeliverable(params))) {
      return false;
    }
    await this.deliverChecked(params);
    return true;
  }

  /**
   * Like deliver, but only the refusal checks run inline — the delivery
   * itself (idle wait, persistence, possibly a whole headless turn, in the
   * worst case many minutes) continues as tracked background work. For
   * callers that must not block on a delivery: the reaper's sweep, the task
   * queue's trigger-run lane.
   */
  async deliverDetached(params: ConversationWakeParams): Promise<boolean> {
    if (!(await this.checkDeliverable(params))) {
      return false;
    }
    trackBackgroundWork(
      this.deliverChecked(params).catch((error) => {
        logger.error(
          {
            err: error,
            conversationId: params.conversationId,
            messageId: params.messageId,
          },
          "Detached wake delivery failed",
        );
      }),
    );
    return true;
  }

  // === Internal ===

  /**
   * Refusal checks shared by both entry points: a deleted conversation has
   * nowhere to deliver to, and a locked chat must never be written
   * server-side.
   */
  private async checkDeliverable(
    params: ConversationWakeParams,
  ): Promise<boolean> {
    const lockInfo = await ConversationModel.getLockedChatKeyInfo(
      params.conversationId,
    );
    if (!lockInfo) {
      logger.warn(
        { conversationId: params.conversationId, messageId: params.messageId },
        "Conversation for a wake delivery no longer exists; dropping it",
      );
      return false;
    }
    if (lockInfo.lockedChat) {
      logger.warn(
        { conversationId: params.conversationId, messageId: params.messageId },
        "Refusing to deliver a wake notification into a locked chat",
      );
      return false;
    }
    return true;
  }

  private async deliverChecked(params: ConversationWakeParams): Promise<void> {
    await this.waitForConversationIdle(params.conversationId);

    // Idempotency: a retried delivery (a worker died between persisting the
    // notification and recording its own completion, and the stuck-task
    // sweep re-ran it) must not persist the notification twice. The turn is
    // still ensured below — the first attempt may have died before it.
    const existing = await MessageModel.findByConversation(
      params.conversationId,
    );
    const alreadyPersisted = existing.some(
      (row) => (row.content as { id?: string } | null)?.id === params.messageId,
    );
    if (alreadyPersisted) {
      logger.info(
        { conversationId: params.conversationId, messageId: params.messageId },
        "Wake notification already persisted; skipping the duplicate write",
      );
    } else {
      await MessageModel.create({
        conversationId: params.conversationId,
        role: "user",
        content: {
          id: params.messageId,
          role: "user",
          parts: [{ type: "text", text: params.text }],
          metadata: params.metadata,
        },
      });
    }

    const owner = await ConversationModel.getOwner(params.conversationId);
    const ownerUserId = owner?.userId ?? params.fallbackUserId ?? null;
    if (!ownerUserId || !owner?.organizationId) {
      // Persisted but not routable — the notification waits in the thread for
      // the next open, and no headless turn runs without a user to run it as.
      logger.warn(
        { conversationId: params.conversationId, messageId: params.messageId },
        "Could not resolve a conversation owner for the wake delivery",
      );
      return;
    }

    broadcastConversationUpdated(
      ownerUserId,
      owner.organizationId,
      params.conversationId,
    );
    broadcastConversationWake(ownerUserId, owner.organizationId, {
      conversationId: params.conversationId,
      messageId: params.messageId,
      text: params.text,
      metadata: params.metadata,
    });

    await this.ensureWakeTurnRuns({
      conversationId: params.conversationId,
      ownerUserId,
      organizationId: owner.organizationId,
      quiet: params.quiet === true,
    });
  }

  /**
   * Give a viewing browser the grace window to claim the wake turn (it
   * resubmits the notification through the ordinary streaming path); when no
   * turn starts, run it headlessly.
   */
  private async ensureWakeTurnRuns(params: {
    conversationId: string;
    ownerUserId: string;
    organizationId: string;
    quiet: boolean;
  }): Promise<void> {
    const deadline = Date.now() + this.timings.headlessGraceMs;
    while (Date.now() < deadline) {
      const running = await ActiveChatRunModel.findRunningByConversation(
        params.conversationId,
      );
      if (running) return; // A browser (or another wake) took the turn.
      await new Promise((resolve) =>
        setTimeout(resolve, this.timings.headlessGracePollMs),
      );
    }
    await this.runHeadlessWakeTurn(params);
  }

  private async runHeadlessWakeTurn(params: {
    conversationId: string;
    ownerUserId: string;
    organizationId: string;
    quiet: boolean;
  }): Promise<void> {
    const { conversationId, ownerUserId, organizationId, quiet } = params;

    const conversation = await ConversationModel.findByIdInOrganization({
      id: conversationId,
      organizationId,
    });
    if (!conversation?.agentId) {
      // No agent left to answer with (deleted agent SET NULLs the FK). The
      // notification stays in the thread; the user picks an agent on open.
      logger.warn(
        { conversationId },
        "Skipping headless wake turn: conversation has no agent",
      );
      return;
    }
    const agent = await AgentModel.findById(conversation.agentId);
    if (!agent) {
      logger.warn(
        { conversationId },
        "Skipping headless wake turn: agent not found",
      );
      return;
    }

    // Same per-conversation mutex as the interactive route: if a browser
    // claimed the turn between the grace check and here, createRun answers
    // null and we simply step aside (the browser path 409s the same way).
    const run = await activeChatRunService.createRun({
      conversationId,
      userId: ownerUserId,
      organizationId,
    });
    if (!run) return;

    const abortController = new AbortController();
    // The user's Stop button must work on headless turns too — this watches
    // stopRequestedAt cross-pod and aborts the execution.
    const stopPolling = activeChatRunService.startStopPolling({
      runId: run.id,
      conversationId,
      abortController,
    });
    // Keep the mutex row alive: the active-run reaper fails rows untouched
    // for 10 minutes, and a headless turn writes no stream events. An empty
    // touch batch is the established liveness primitive. If the row vanished
    // anyway (reaped, requested gone), stop the turn — the mutex is lost.
    const liveness = setInterval(() => {
      void ActiveChatRunModel.appendEvents({
        runId: run.id,
        seq: 0,
        payloads: [],
        touchRun: true,
      })
        .then((result) => {
          if (result === "run_missing") abortController.abort();
        })
        .catch(() => {
          // Transient DB errors: the next touch retries; the reaper margin
          // (10 min vs 1 min cadence) absorbs several misses.
        });
    }, this.timings.headlessLivenessIntervalMs);
    liveness.unref();

    try {
      // Mirror the interactive route's message preparation. The injection
      // steps (`injectSkillActivation`, `injectAppDiagnostics`) act only on
      // the LAST user message's metadata — here always the harness
      // notification, which carries neither a skill ref nor app diagnostics —
      // so they are provably inert and deliberately skipped.
      const rows = await MessageModel.findByConversation(conversationId);
      const history = normalizeChatMessages(
        rows.map((row) => row.content as ChatMessage),
      );

      // Resolve the exact model the executor itself will resolve, so provider
      // normalization inside buildModelMessages targets the right provider.
      const selection = await resolveConversationLlmSelectionForAgent({
        agent: { llmApiKeyId: agent.llmApiKeyId, modelId: agent.modelId },
        organizationId,
        userId: ownerUserId,
        includeMemberChatDefault: false,
      });

      const { modelMessages } = await buildModelMessages({
        messages: history,
        conversationId,
        organizationId,
        userId: ownerUserId,
        agentId: agent.id,
        provider: selection.selectedProvider,
        selectedModel: selection.selectedModel,
        modelId: selection.modelId,
        agentLlmApiKeyId: agent.llmApiKeyId,
        abortSignal: abortController.signal,
        // Compaction events stream UI hints; there is no stream here.
        emit: () => {},
      });

      const result = await executeA2AMessage({
        agentId: agent.id,
        // The prepared history already ends with the wake notification, so
        // there is no separate current turn to append.
        messages: modelMessages,
        message: "",
        organizationId,
        userId: ownerUserId,
        sessionId: conversationId,
        conversationId,
        originalUiMessages: history as unknown as UIMessage[],
        abortSignal: abortController.signal,
      });

      // Monitor mode: a reply leading with the no-change sentinel collapses
      // to a muted line and leaves the conversation read.
      const isQuietNoChange =
        quiet && result.text.trimStart().startsWith(QUIET_WAKE_SENTINEL);
      await MessageModel.create({
        conversationId,
        role: "assistant",
        content: isQuietNoChange
          ? {
              ...result.responseUiMessage,
              metadata: {
                ...(result.responseUiMessage.metadata as
                  | Record<string, unknown>
                  | undefined),
                quietWake: true,
              },
            }
          : result.responseUiMessage,
      });
      if (isQuietNoChange) {
        await ConversationModel.markRead({
          id: conversationId,
          userId: ownerUserId,
          organizationId,
        });
      }
      await activeChatRunService.markTerminal({
        runId: run.id,
        status: "completed",
      });
      logger.info(
        { conversationId, runId: run.id, quietNoChange: isQuietNoChange },
        "Headless wake turn completed",
      );
    } catch (error) {
      const aborted = abortController.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      if (!aborted) {
        // Same visible error card the interactive chat renders — a failed
        // wake turn must never fail silently.
        await ConversationChatErrorModel.create({
          conversationId,
          error:
            error instanceof ProviderError
              ? error.chatErrorResponse
              : {
                  code: ChatErrorCode.Unknown,
                  message,
                  isRetryable: false,
                },
        }).catch((persistError) => {
          logger.error(
            { err: persistError, conversationId },
            "Failed to persist a headless wake turn error",
          );
        });
      }
      await activeChatRunService.markTerminal({
        runId: run.id,
        status: aborted ? "cancelled" : "failed",
        error: aborted ? null : message,
      });
      logger.warn(
        { err: error, conversationId, runId: run.id, aborted },
        "Headless wake turn did not complete",
      );
    } finally {
      clearInterval(liveness);
      stopPolling();
      broadcastConversationUpdated(ownerUserId, organizationId, conversationId);
    }
  }

  /**
   * Wait until the conversation has no running chat turn, so the injected
   * notification can never interleave with an in-flight run's persistence.
   * After the deadline the notification is delivered anyway — it will be
   * picked up whenever the conversation is next opened.
   */
  private async waitForConversationIdle(conversationId: string): Promise<void> {
    const deadline = Date.now() + this.timings.idleWaitDeadlineMs;
    while (Date.now() < deadline) {
      const running =
        await ActiveChatRunModel.findRunningByConversation(conversationId);
      if (!running) return;
      await new Promise((resolve) =>
        setTimeout(resolve, this.timings.idlePollMs),
      );
    }
    logger.warn(
      { conversationId },
      "Conversation stayed busy past the idle-wait deadline; delivering the wake notification anyway",
    );
  }
}

export const conversationWakeService = new ConversationWakeService();
