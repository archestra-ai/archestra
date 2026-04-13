import { executeA2AMessage } from "@/agents/a2a-executor";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  UserModel,
} from "@/models";

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
    return;
  }

  let status: "success" | "failed" = "success";
  let errorMessage: string | null = null;

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

    const agent = await AgentModel.findById(trigger.agentId);
    if (!agent) {
      throw new Error("Scheduled trigger target agent no longer exists");
    }

    if (agent.agentType !== "agent") {
      throw new Error("Scheduled trigger target must be an internal agent");
    }

    await executeA2AMessage({
      agentId: trigger.agentId,
      message: trigger.messageTemplate,
      organizationId: trigger.organizationId,
      userId: actor.id,
      sessionId: `scheduled-${run.id}`,
      source: "schedule-trigger",
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

  await ScheduleTriggerRunModel.markCompleted({
    runId: run.id,
    status,
    error: errorMessage,
  });

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
