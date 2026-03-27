import logger from "@/logging";
import { AgentScheduleTriggerModel, TaskModel } from "@/models";
import { taskQueueService } from "@/task-queue";

export async function handleCheckDueAgentSchedules(): Promise<void> {
  const dueTriggers = await AgentScheduleTriggerModel.findDueTriggers();

  for (const trigger of dueTriggers) {
    try {
      const exists = await TaskModel.hasPendingOrProcessingByType(
        `execute_agent_schedule:${trigger.id}`,
      );
      if (exists) continue;

      await taskQueueService.enqueue({
        taskType: "execute_agent_schedule",
        payload: { triggerId: trigger.id },
      });

      logger.info(
        {
          triggerId: trigger.id,
          agentId: trigger.agentId,
          triggerType: trigger.triggerType,
          name: trigger.name,
        },
        "Enqueued agent schedule trigger execution",
      );
    } catch (error) {
      logger.warn(
        {
          triggerId: trigger.id,
          agentId: trigger.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to enqueue agent schedule trigger",
      );
    }
  }
}
