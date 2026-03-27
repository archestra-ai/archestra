import { Cron } from "croner";
import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import { AgentModel, AgentScheduleTriggerModel } from "@/models";

const EXECUTION_TIMEOUT_MS = 300_000; // 5 minutes

export async function handleExecuteAgentSchedule(
  payload: Record<string, unknown>,
): Promise<void> {
  const triggerId = payload.triggerId as string;
  if (!triggerId) {
    throw new Error("Missing triggerId in execute_agent_schedule payload");
  }

  const trigger = await AgentScheduleTriggerModel.findById(triggerId);
  if (!trigger) {
    logger.warn({ triggerId }, "Schedule trigger not found, skipping");
    return;
  }

  if (!trigger.enabled) {
    logger.debug({ triggerId }, "Schedule trigger disabled, skipping");
    return;
  }

  const agent = await AgentModel.findById(trigger.agentId);
  if (!agent) {
    logger.warn(
      { triggerId, agentId: trigger.agentId },
      "Agent not found for schedule trigger",
    );
    await AgentScheduleTriggerModel.markExecuted({
      id: triggerId,
      nextExecutionAt: null,
      error: "Agent not found",
    });
    return;
  }

  const nextExecutionAt = computeNextExecution(trigger);

  try {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      EXECUTION_TIMEOUT_MS,
    );

    try {
      await executeA2AMessage({
        agentId: trigger.agentId,
        message: trigger.message || `Scheduled execution: ${trigger.name}`,
        organizationId: trigger.organizationId,
        userId: agent.authorId ?? "",
        source: "schedule",
        abortSignal: abortController.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    await AgentScheduleTriggerModel.markExecuted({
      id: triggerId,
      nextExecutionAt,
    });

    logger.info(
      {
        triggerId,
        agentId: trigger.agentId,
        triggerName: trigger.name,
        nextExecutionAt,
      },
      "Agent schedule trigger executed successfully",
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    await AgentScheduleTriggerModel.markExecuted({
      id: triggerId,
      nextExecutionAt,
      error: errorMessage,
    });

    logger.error(
      {
        triggerId,
        agentId: trigger.agentId,
        triggerName: trigger.name,
        error: errorMessage,
      },
      "Agent schedule trigger execution failed",
    );
  }
}

// ===== Internal helpers =====

function computeNextExecution(trigger: {
  triggerType: string;
  cronExpression: string | null;
  intervalSeconds: number | null;
}): Date | null {
  if (trigger.triggerType === "cron" && trigger.cronExpression) {
    try {
      const cron = new Cron(trigger.cronExpression);
      return cron.nextRun() ?? null;
    } catch {
      return null;
    }
  }

  if (trigger.triggerType === "interval" && trigger.intervalSeconds) {
    return new Date(Date.now() + trigger.intervalSeconds * 1000);
  }

  // one_time triggers don't reschedule
  return null;
}
