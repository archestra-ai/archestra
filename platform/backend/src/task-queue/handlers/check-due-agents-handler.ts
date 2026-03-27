import { Cron } from "croner";
import logger from "@/logging";
import { AgentModel } from "@/models";
import { taskQueueService } from "@/task-queue";

export async function handleCheckDueAgents(): Promise<void> {
  const agents = await AgentModel.findAllScheduled();

  for (const agent of agents) {
    if (!agent.schedule) continue;

    try {
      const cron = new Cron(agent.schedule);
      const nextRun = cron.nextRun(agent.lastScheduledRunAt ?? new Date(0));

      if (nextRun && nextRun <= new Date()) {
        // Note: We enqueue directly here. The previous use of
        // TaskModel.hasPendingOrProcessing was connector-specific and did
        // not correctly deduplicate agent_run tasks by agentId.
        await taskQueueService.enqueue({
          taskType: "agent_run",
          payload: { agentId: agent.id },
        });
        logger.info(
          {
            agentId: agent.id,
            agentName: agent.name,
          },
          "Enqueued scheduled agent run",
        );
      }
    } catch (error) {
      logger.warn(
        {
          agentId: agent.id,
          agentName: agent.name,
          schedule: agent.schedule,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to evaluate agent schedule",
      );
    }
  }
}
