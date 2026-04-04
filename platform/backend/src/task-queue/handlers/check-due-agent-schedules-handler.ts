import { Cron } from "croner";
import logger from "@/logging";
import { AgentModel, AgentScheduleModel } from "@/models";
import { executeA2AMessage } from "@/agents/a2a-executor";

export async function handleCheckDueAgentSchedules(): Promise<void> {
  const dueSchedules = await AgentScheduleModel.findAllDue();

  for (const schedule of dueSchedules) {
    try {
      const agent = await AgentModel.findById(schedule.agentId);
      if (!agent) {
        logger.warn(
          { scheduleId: schedule.id, agentId: schedule.agentId },
          "Agent not found for due schedule, deactivating",
        );
        await AgentScheduleModel.update(schedule.id, { isActive: false });
        continue;
      }

      // Trigger the agent
      // We use the author's identity for the run. If no author, we use a system user or fail.
      const userId = agent.authorId;
      if (!userId) {
        logger.warn(
          { scheduleId: schedule.id, agentId: agent.id },
          "Agent has no authorId, cannot execute scheduled run",
        );
        await AgentScheduleModel.update(schedule.id, { isActive: false });
        continue;
      }

      await executeA2AMessage({
        agentId: agent.id,
        message: schedule.payload || "Scheduled run",
        organizationId: agent.organizationId,
        userId: userId,
        source: "api", 
      });

      // Calculate next run
      const cron = new Cron(schedule.cron);
      const nextRun = cron.next(new Date());

      await AgentScheduleModel.update(schedule.id, {
        lastRunAt: new Date(),
        nextRunAt: nextRun,
      });

      logger.info(
        {
          scheduleId: schedule.id,
          agentId: agent.id,
          agentName: agent.name,
          nextRun,
        },
        "Executed scheduled agent run",
      );
    } catch (error) {
      logger.error(
        {
          scheduleId: schedule.id,
          agentId: schedule.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to execute agent schedule",
      );

      // Update next run even if failed to avoid infinite loop on same timestamp
      try {
        const cron = new Cron(schedule.cron);
        const nextRun = cron.next(new Date());
        await AgentScheduleModel.update(schedule.id, { nextRunAt: nextRun });
      } catch (e) {
        // If cron is invalid, deactivate
        await AgentScheduleModel.update(schedule.id, { isActive: false });
      }
    }
  }
}
