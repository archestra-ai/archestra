import { ChatErrorCode, type ChatErrorResponse } from "@archestra/shared";
import {
  type A2AExecuteResult,
  executeA2AMessage,
} from "@/agents/a2a-executor";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  UserModel,
} from "@/models";
import { metrics } from "@/observability";
import { ProviderError } from "@/routes/chat/errors";
import {
  createAndLinkRunConversation,
  persistRunConversationMessages,
  persistRunUserMessage,
  recordRunConversationError,
} from "@/services/scheduled-run-conversation";
import type { Conversation } from "@/types";

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

    // For a project-scoped trigger, materialize the run's chat conversation up
    // front and execute against it, so the file tools resolve the project scope
    // (results land in the project). Unscoped triggers keep the headless path.
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

function formatScheduleTriggerExecutionError(errorMessage: string): string {
  if (!errorMessage.includes("only supports Interactions API")) {
    return errorMessage;
  }

  return `${errorMessage} Scheduled triggers need a different chat-capable model for this agent. Pick a model that supports standard text and tool execution for scheduled runs, then try again.`;
}
