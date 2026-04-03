import logger from "@/logging";
import { AgentScheduleModel } from "@/models";
import { executeA2AMessage } from "@/agents/a2a-executor";

/**
 * Handles the actual execution of a scheduled agent run.
 * Includes "Smart" pre-flight checks and schedule updates.
 */
export async function handleTriggerAgentSchedule(payload: Record<string, unknown>): Promise<void> {
  const scheduleId = payload.scheduleId as string;
  const schedule = await AgentScheduleModel.update(scheduleId, { lastRunAt: new Date() });

  if (!schedule || !schedule.enabled) {
    logger.warn({ scheduleId }, "Schedule not found or disabled, skipping execution");
    return;
  }

  try {
    // 1. Update next run time IMMEDIATELY to prevent race conditions
    await AgentScheduleModel.updateNextRun(schedule.id, schedule.cron, schedule.lastRunAt || new Date());

    // 2. TODO: Implement Condition Tool Check (Pre-flight)
    // For now, we proceed to direct execution. 
    // In the A2A Executor, we will inject the temporal context.

    logger.info(
      { agentId: schedule.agentId, scheduleId },
      "Executing scheduled agent run",
    );

    // 3. Execute the agent autonomously
    // Note: We use a default message or the schedule could potentially store a specific prompt.
    await executeA2AMessage({
      agentId: schedule.agentId,
      message: "Scheduled execution triggered. Please check for updates and perform your routine tasks.",
      organizationId: schedule.organizationId, 
      userId: schedule.authorId || "system", 
      source: "api",
      lastRunAt: schedule.lastRunAt || undefined,
    });

    logger.info(
      { agentId: schedule.agentId, scheduleId },
      "Successfully completed scheduled agent run",
    );
  } catch (error) {
    logger.error(
      {
        scheduleId,
        agentId: schedule.agentId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed during scheduled agent execution",
    );
    throw error; // Let the task queue handle retries if configured
  }
}
