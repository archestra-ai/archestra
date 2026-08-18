import {
  ChatErrorCode,
  type ChatErrorResponse,
  QUIET_WAKE_SENTINEL,
} from "@archestra/shared";
import {
  type A2AExecuteResult,
  executeA2AMessage,
} from "@/agents/a2a-executor";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ConversationModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  UserModel,
} from "@/models";
import { metrics } from "@/observability";
import { ProviderError } from "@/routes/chat/errors";
import { conversationWakeService } from "@/services/conversation-wake";
import {
  createAndLinkRunConversation,
  persistRunConversationMessages,
  persistRunUserMessage,
  recordRunConversationError,
} from "@/services/scheduled-run-conversation";
import type { Conversation, ScheduleTrigger } from "@/types";

export async function handleScheduleTriggerRunExecution(
  payload: Record<string, unknown>,
): Promise<void> {
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  if (!runId) {
    throw new Error("Missing runId in schedule trigger execution payload");
  }

  const triggerId =
    typeof payload.triggerId === "string" ? payload.triggerId : null;

  logger.info({ runId, triggerId }, "Schedule trigger run picked up");

  const run = await ScheduleTriggerRunModel.findById(runId);
  if (!run || run.status !== "running") {
    logger.warn(
      { runId, found: !!run, status: run?.status ?? null },
      "Schedule trigger run skipped, not in running state",
    );
    return;
  }

  const trigger = await ScheduleTriggerModel.findById(run.triggerId);
  if (!trigger) {
    logger.warn(
      { runId: run.id, triggerId: run.triggerId },
      "Schedule trigger run failed, trigger no longer exists",
    );
    await ScheduleTriggerRunModel.markCompleted({
      runId: run.id,
      status: "failed",
      error: "Trigger no longer exists",
    });
    metrics.scheduleTrigger.reportScheduleTriggerRun("unknown", "failed");
    return;
  }

  const triggerAgent = await AgentModel.findById(trigger.agentId);
  const agentName = triggerAgent?.name ?? "unknown";

  let status: "success" | "failed" = "success";
  let errorMessage: string | null = null;
  // The structured error for a failed run's chat error card (see catch below).
  let runChatError: ChatErrorResponse | null = null;
  // Captured for post-completion transcript persistence: a project-scoped run's
  // chat conversation is created up front and the executor result is persisted
  // after execution completes.
  let runConversation: Conversation | null = null;
  let executeResult: A2AExecuteResult | null = null;

  try {
    const actor = await UserModel.getById(trigger.actorUserId);
    if (!actor) {
      throw new Error("Scheduled trigger actor no longer exists");
    }
    const userIsAgentAdmin = await hasAnyAgentTypeAdminPermission({
      userId: actor.id,
      organizationId: trigger.organizationId,
    });

    const hasAgentAccess = await AgentTeamModel.userHasAgentAccess(
      actor.id,
      trigger.agentId,
      userIsAgentAdmin,
    );
    if (!hasAgentAccess) {
      throw new Error(
        "Scheduled trigger actor no longer has access to the target agent",
      );
    }

    if (!triggerAgent) {
      throw new Error("Scheduled trigger target agent no longer exists");
    }

    if (triggerAgent.agentType !== "agent") {
      throw new Error("Scheduled trigger target must be an internal agent");
    }

    if (trigger.conversationId) {
      // Conversation-targeted wakeup (created by the schedule_wakeup chat
      // tool): deliver into the EXISTING conversation through the wake
      // service — a viewing browser answers it as a streaming turn, and with
      // no browser the wake service runs the turn headlessly. No run
      // conversation is created; the run links to the target conversation.
      const conversation = await ConversationModel.findByIdInOrganization({
        id: trigger.conversationId,
        organizationId: trigger.organizationId,
      });
      if (!conversation) {
        throw new Error("The wakeup's conversation no longer exists");
      }
      if (conversation.userId !== actor.id) {
        // Defensive: wakeups are created by the conversation owner, and the
        // wake turn runs as the owner — refuse if that invariant ever breaks.
        throw new Error(
          "The wakeup's conversation no longer belongs to its creator",
        );
      }
      await ScheduleTriggerRunModel.setChatConversationId(
        run.id,
        conversation.id,
      );
      // Detached: the refusal checks run inline (deleted/locked conversation
      // fails the run), but the delivery itself — which can wait minutes for
      // a busy conversation and then run a whole wake turn — must not pin
      // this task-queue lane. A post-acceptance turn failure surfaces in the
      // conversation as a chat error card, not on the run row.
      const delivered = await conversationWakeService.deliverDetached({
        conversationId: conversation.id,
        messageId: `sched-wake-${run.id}`,
        text: buildScheduledWakeupText(trigger),
        metadata: {
          scheduledWakeup: {
            triggerId: trigger.id,
            runId: run.id,
            name: trigger.name,
            recurring: trigger.runAt === null,
            quiet: trigger.quiet,
          },
        },
        fallbackUserId: actor.id,
        quiet: trigger.quiet,
      });
      if (!delivered) {
        throw new Error(
          "Wake delivery was refused — the conversation was deleted or is locked",
        );
      }
    } else {
      // For a project-scoped trigger, materialize the run's chat conversation
      // up front and execute against it, so the file tools resolve the project
      // scope (results land in the project). Unscoped triggers keep the
      // headless path.
      let conversationId: string | undefined;
      if (trigger.projectId) {
        const conversation = await createAndLinkRunConversation({
          run,
          trigger,
          ownerUserId: actor.id,
          organizationId: trigger.organizationId,
        });
        conversationId = conversation.id;
        runConversation = conversation;
      }

      executeResult = await executeA2AMessage({
        agentId: trigger.agentId,
        message: trigger.messageTemplate,
        organizationId: trigger.organizationId,
        userId: actor.id,
        sessionId: `scheduled-${run.id}`,
        conversationId,
        source: "schedule-trigger",
        scheduleTriggerRunId: run.id,
      });
    }
  } catch (error) {
    status = "failed";
    errorMessage = formatScheduleTriggerExecutionError(
      error instanceof Error ? error.message : String(error),
    );
    // Prefer the provider's structured error (proper code + retryability), so a
    // failed run's chat shows the same rich error card as the interactive chat;
    // fall back to a generic card carrying the formatted message.
    runChatError =
      error instanceof ProviderError
        ? error.chatErrorResponse
        : {
            code: ChatErrorCode.Unknown,
            message: errorMessage,
            isRetryable: false,
          };
    logger.warn(
      { runId: run.id, triggerId: run.triggerId, error: errorMessage },
      "Scheduled trigger run failed",
    );
  }

  await ScheduleTriggerRunModel.markCompleted({
    runId: run.id,
    status,
    error: errorMessage,
  });

  // For a project-scoped run that executed successfully, persist the chat
  // transcript from the executor's own result (the user prompt + the complete
  // assistant turn). This is race-free — unlike reading the `interactions` rows,
  // which the proxy commits after the stream is flushed and so may not yet be
  // visible at completion. So the conversation isn't blank (or missing its final
  // answer) when opened from any surface (project chat list, sidebar, direct
  // link). Best-effort: a persist failure must not fail the already-completed run.
  if (status === "success" && runConversation && executeResult) {
    try {
      await persistRunConversationMessages({
        conversation: runConversation,
        userText: trigger.messageTemplate,
        assistantMessage: executeResult.responseUiMessage,
      });
    } catch (error) {
      logger.warn(
        {
          runId: run.id,
          triggerId: run.triggerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to persist scheduled run conversation messages",
      );
    }
  } else if (status === "failed" && runConversation) {
    // A failed project-scoped run keeps its conversation: persist the scheduled
    // prompt as the user message (so the chat carries it and the scheduled-run
    // "Try again" can resend it) and record the structured error as a chat error
    // so the run's chat shows an inline error card rather than a blank transcript.
    // Best-effort: this must not fail the already-failed run.
    try {
      await persistRunUserMessage({
        conversation: runConversation,
        userText: trigger.messageTemplate,
      });
      if (runChatError) {
        await recordRunConversationError({
          conversationId: runConversation.id,
          error: runChatError,
        });
      }
    } catch (error) {
      logger.warn(
        {
          runId: run.id,
          triggerId: run.triggerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to record scheduled run conversation error",
      );
    }
  }

  metrics.scheduleTrigger.reportScheduleTriggerRun(agentName, status);

  logger.info(
    { runId: run.id, triggerId: run.triggerId, status, error: errorMessage },
    "Schedule trigger run completed",
  );
}

/**
 * The wake-notification text a conversation-targeted wakeup injects. The
 * scheduled prompt is the payload; the framing tells the model where it came
 * from so it reacts rather than treating it as a fresh user question.
 */
function buildScheduledWakeupText(trigger: ScheduleTrigger): string {
  const quietInstruction = trigger.quiet
    ? ` This is a QUIET monitor check: if nothing noteworthy changed, start your reply with the exact text ${QUIET_WAKE_SENTINEL} followed by a one-line status — it will be collapsed. If something DID change, reply normally without the sentinel.`
    : "";
  return (
    `[Scheduled wakeup] ${trigger.name}\n\n${trigger.messageTemplate}\n\n` +
    `(This scheduled check-in was set up earlier in this conversation. Act on it now and report anything noteworthy to the user.${quietInstruction})`
  );
}

function formatScheduleTriggerExecutionError(errorMessage: string): string {
  if (!errorMessage.includes("only supports Interactions API")) {
    return errorMessage;
  }

  return `${errorMessage} Scheduled triggers need a different chat-capable model for this agent. Pick a model that supports standard text and tool execution for scheduled runs, then try again.`;
}
