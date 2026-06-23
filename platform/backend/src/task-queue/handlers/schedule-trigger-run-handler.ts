import { executeA2AMessage } from "@/agents/a2a-executor";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import { withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  UserModel,
} from "@/models";
import { metrics } from "@/observability";
import {
  appendRunMessagesToConversation,
  ensureTriggerConversation,
  syncRunArtifactToConversation,
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
  let conversation: Conversation | undefined;

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

    // Materialize the schedule's single shared chat conversation up front and
    // execute against it. The conversation gives the file tools a scope to
    // resolve — project scope for a project trigger, the user's
    // `<email>/<conversationId>/` folder for an unscoped one — so a run's files
    // never land in the flat headless bucket. Mirror the link onto the run so
    // run-level navigation and lookups keep working.
    conversation = await ensureTriggerConversation({
      trigger,
      ownerUserId: actor.id,
      organizationId: trigger.organizationId,
    });
    await ScheduleTriggerRunModel.setChatConversationId(
      run.id,
      conversation.id,
    );

    await executeA2AMessage({
      agentId: trigger.agentId,
      message: trigger.messageTemplate,
      organizationId: trigger.organizationId,
      userId: actor.id,
      sessionId: `scheduled-${run.id}`,
      conversationId: conversation.id,
      source: "schedule-trigger",
      scheduleTriggerRunId: run.id,
    });
  } catch (error) {
    status = "failed";
    errorMessage = formatScheduleTriggerExecutionError(
      error instanceof Error ? error.message : String(error),
    );
    logger.warn(
      { runId: run.id, triggerId: run.triggerId, error: errorMessage },
      "Scheduled trigger run failed",
    );
  }

  if (status === "success" && conversation) {
    // Persist the run's turn ATOMICALLY with flipping it to `success`: the
    // `markCompleted` CAS (on `running` status) and the message append commit in
    // one transaction. Only the worker that wins the CAS appends, so a
    // retried/duplicate delivery (which early-returns above once the run is no
    // longer `running`) can never double-append — and a crash mid-way rolls back
    // both, so a run is never marked done with its messages lost.
    const finishedRun = (await ScheduleTriggerRunModel.findById(run.id)) ?? run;
    const persisted = await withDbTransaction(async (tx) => {
      const completed = await ScheduleTriggerRunModel.markCompleted(
        { runId: run.id, status, error: errorMessage },
        tx,
      );
      if (!completed) {
        return false;
      }
      await appendRunMessagesToConversation(
        { conversation, trigger, run: finishedRun },
        tx,
      );
      return true;
    });
    // Artifact sync is idempotent (latest run wins), so it stays out of the
    // transaction.
    if (persisted) {
      await syncRunArtifactToConversation({
        conversation,
        run: finishedRun,
        organizationId: trigger.organizationId,
      });
    }
  } else {
    await ScheduleTriggerRunModel.markCompleted({
      runId: run.id,
      status,
      error: errorMessage,
    });
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
