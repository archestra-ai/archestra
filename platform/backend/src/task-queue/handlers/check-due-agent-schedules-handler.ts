import logger from "@/logging";
import {
  AgentModel,
  AgentScheduleTriggerModel,
  TaskModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";
import { executeA2AMessage } from "@/agents/a2a-executor";

export async function handleCheckDueAgentSchedules(): Promise<void> {
  const triggers = await AgentScheduleTriggerModel.findDueTriggers();

  logger.info(
    { count: triggers.length },
    "Checking due agent schedule triggers",
  );

  for (const trigger of triggers) {
    try {
      // Check if there's already a pending task for this trigger
      const exists = await TaskModel.hasPendingOrProcessing(
        "execute_agent_schedule_trigger",
        trigger.id,
      );

      if (exists) {
        logger.debug(
          { triggerId: trigger.id, triggerName: trigger.name },
          "Skipping trigger - task already pending",
        );
        continue;
      }

      // Verify the agent still exists
      const agent = await AgentModel.findById(trigger.agentId);
      if (!agent) {
        logger.warn(
          { triggerId: trigger.id, agentId: trigger.agentId },
          "Agent not found for schedule trigger - disabling",
        );
        await AgentScheduleTriggerModel.update(trigger.id, { enabled: false });
        continue;
      }

      // Enqueue the execution task
      await taskQueueService.enqueue({
        taskType: "execute_agent_schedule_trigger",
        payload: {
          triggerId: trigger.id,
          agentId: trigger.agentId,
          message: trigger.message,
          payload: trigger.payload,
        },
      });

      logger.info(
        {
          triggerId: trigger.id,
          triggerName: trigger.name,
          agentId: trigger.agentId,
        },
        "Enqueued agent schedule trigger execution",
      );
    } catch (error) {
      logger.error(
        {
          triggerId: trigger.id,
          triggerName: trigger.name,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to process agent schedule trigger",
      );
    }
  }
}

export async function handleExecuteAgentScheduleTrigger(
  payload: Record<string, unknown>,
): Promise<void> {
  const {
    triggerId,
    agentId,
    message,
    payload: triggerPayload,
  } = payload as {
    triggerId: string;
    agentId: string;
    message: string;
    payload?: Record<string, unknown>;
  };

  logger.info(
    { triggerId, agentId },
    "Executing agent schedule trigger",
  );

  try {
    // Get the trigger to access organization/user info
    const trigger = await AgentScheduleTriggerModel.findById(triggerId);
    if (!trigger) {
      logger.error({ triggerId }, "Trigger not found");
      return;
    }

    // Build the message with payload context if available
    let fullMessage = message;
    if (triggerPayload && Object.keys(triggerPayload).length > 0) {
      fullMessage = `${message}\n\nContext: ${JSON.stringify(triggerPayload, null, 2)}`;
    }

    // Execute the agent
    const result = await executeA2AMessage({
      agentId,
      message: fullMessage,
      organizationId: trigger.organizationId,
      userId: trigger.organizationId, // Use org ID as user ID for scheduled triggers
      source: "schedule",
    });

    // Mark the trigger as executed
    await AgentScheduleTriggerModel.markExecuted(triggerId, true);

    logger.info(
      {
        triggerId,
        agentId,
        messageId: result.messageId,
        finishReason: result.finishReason,
      },
      "Agent schedule trigger executed successfully",
    );
  } catch (error) {
    // Mark the trigger as failed
    await AgentScheduleTriggerModel.markExecuted(triggerId, false);

    logger.error(
      {
        triggerId,
        agentId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Agent schedule trigger execution failed",
    );

    throw error; // Re-throw to let the task queue handle retries
  }
}
