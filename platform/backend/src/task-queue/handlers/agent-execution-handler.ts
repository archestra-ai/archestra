import logger from "@/logging";
import { AgentScheduleModel } from "@/models";
import { executeA2AMessage } from "@/agents/a2a-executor";

/**
 * Executes a message against an Agent as triggered by a schedule.
 * 
 * This handler is responsible for creating a run record, calling the LLM executor,
 * and updating the run record with the result or error.
 */
export async function handleAgentExecution(payload: Record<string, unknown>): Promise<void> {
  const { triggerId } = payload as { triggerId: string };

  const trigger = await AgentScheduleModel.getTrigger(triggerId);
  if (!trigger) {
    logger.error({ triggerId }, "Agent schedule trigger not found");
    return;
  }

  // Only execute if active. If it was paused after being enqueued, we skip.
  if (trigger.status !== "active") {
    logger.warn(
      { triggerId, status: trigger.status },
      "Agent schedule trigger is not active, skipping execution",
    );
    return;
  }

  // Extract necessary fields from the trigger payload.
  // The payload should contain the context required for A2A execution.
  const triggerPayload = trigger.payload as {
    message?: string;
    userId?: string;
    organizationId?: string;
  };

  if (!triggerPayload.message || !triggerPayload.userId || !triggerPayload.organizationId) {
    logger.error(
      { triggerId, payload: triggerPayload },
      "Missing required fields in agent schedule trigger payload",
    );
    return;
  }

  // 1. Create a run record in 'running' state
  const run = await AgentScheduleModel.createRun({
    triggerId: trigger.id,
    status: "running",
    startedAt: new Date(),
  });

  try {
    logger.info(
      {
        triggerId: trigger.id,
        agentId: trigger.agentId,
        runId: run.id,
        userId: triggerPayload.userId,
      },
      "Starting scheduled agent execution",
    );

    // 2. Call the Agent-to-Agent message executor
    const result = await executeA2AMessage({
      agentId: trigger.agentId,
      message: triggerPayload.message,
      userId: triggerPayload.userId,
      organizationId: triggerPayload.organizationId,
      source: "api", // Mark as API source to differentiate from Chat
    });

    // 3. Update run record on success
    await AgentScheduleModel.updateRun(run.id, {
      status: "success",
      finishedAt: new Date(),
      output: {
        messageId: result.messageId,
        text: result.text,
        usage: result.usage,
      },
    });

    logger.info(
      { triggerId: trigger.id, agentId: trigger.agentId, runId: run.id },
      "Scheduled agent execution completed successfully",
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // 4. Update run record on failure
    await AgentScheduleModel.updateRun(run.id, {
      status: "failure",
      finishedAt: new Date(),
      error: errorMessage,
    });

    logger.error(
      {
        triggerId: trigger.id,
        agentId: trigger.agentId,
        runId: run.id,
        error: errorMessage,
      },
      "Scheduled agent execution failed",
    );

    // 5. Update failure count on the trigger for monitoring
    await AgentScheduleModel.updateTrigger(trigger.id, {
      failureCount: trigger.failureCount + 1,
    });
  }
}
