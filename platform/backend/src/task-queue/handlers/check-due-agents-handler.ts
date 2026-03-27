import { Cron } from "croner";
import logger from "@/logging";
import { AgentModel, TaskModel } from "@/models";
import { taskQueueService } from "@/task-queue";

/**
 * Periodically checks for agents that have a schedule enabled and are due for execution.
 * Enqueues an 'agent_trigger' task for each due agent.
 */
export async function handleCheckDueAgents(): Promise<void> {
  // 1. Fetch all agents with schedule enabled
  const agents = await AgentModel.findAllWithScheduleEnabled();

  for (const agent of agents) {
    if (!agent.scheduleExpression) continue;

    try {
      const cron = new Cron(agent.scheduleExpression);
      // We use the lastScheduledRunAt or createdAt as the starting point for evaluation
      const lastRun = agent.lastScheduledRunAt ?? agent.createdAt ?? new Date(0);
      const nextRun = cron.nextRun(lastRun);

      // If the calculated next run is in the past or now, it's time to trigger
      if (nextRun && nextRun <= new Date()) {
        const exists = await TaskModel.hasPendingOrProcessing(
          "agent_trigger",
          agent.id,
        );

        if (!exists) {
          await taskQueueService.enqueue({
            taskType: "agent_trigger",
            payload: { 
              agentId: agent.id,
              triggeredAt: new Date().toISOString(),
              message: agent.scheduledMessage || "Scheduled execution"
            },
          });

          logger.info(
            {
              agentId: agent.id,
              agentName: agent.name,
              schedule: agent.scheduleExpression,
            },
            "Enqueued scheduled agent trigger",
          );

          // Update the lastScheduledRunAt immediately to prevent double-queuing 
          // in the next check cycle before the task is picked up
          await AgentModel.update(agent.id, {
            lastScheduledRunAt: new Date(),
          });
        }
      }
    } catch (error) {
      logger.warn(
        {
          agentId: agent.id,
          agentName: agent.name,
          schedule: agent.scheduleExpression,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to evaluate agent schedule",
      );
    }
  }
}
