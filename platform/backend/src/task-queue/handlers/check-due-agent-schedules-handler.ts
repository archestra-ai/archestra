import logger from "@/logging";
import { AgentScheduleModel, TaskModel } from "@/models";
import { taskQueueService } from "@/task-queue";

/**
 * Periodically checks for agent schedules that are due for execution.
 */
export async function handleCheckDueAgentSchedules(): Promise<void> {
  const dueSchedules = await AgentScheduleModel.findDue();

  for (const schedule of dueSchedules) {
    try {
      // Check if a trigger task is already pending for this schedule to avoid duplicates
      const exists = await TaskModel.hasPendingOrProcessing(
        "trigger_agent_schedule",
        schedule.id,
      );

      if (!exists) {
        await taskQueueService.enqueue({
          taskType: "trigger_agent_schedule",
          payload: { scheduleId: schedule.id },
        });

        logger.info(
          {
            scheduleId: schedule.id,
            agentId: schedule.agentId,
          },
          "Enqueued scheduled agent execution task",
        );
      }
    } catch (error) {
      logger.warn(
        {
          scheduleId: schedule.id,
          agentId: schedule.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to enqueue agent schedule trigger task",
      );
    }
  }
}
