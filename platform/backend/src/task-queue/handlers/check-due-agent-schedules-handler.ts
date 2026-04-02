import { Cron } from "croner";
import logger from "@/logging";
import { AgentScheduleModel } from "@/models";
import { taskQueueService } from "@/task-queue";

/**
 * Scheduler handler — runs every 60 seconds.
 *
 * For each enabled agent schedule, it checks whether the cron expression
 * is due based on `lastRunAt`. If so, it enqueues an `agent_schedule_run`
 * task that will invoke the agent with the configured message.
 *
 * Mirrors the pattern of `handleCheckDueConnectors` for consistency.
 */
export async function handleCheckDueAgentSchedules(): Promise<void> {
  const schedules = await AgentScheduleModel.findAllEnabled();

  for (const schedule of schedules) {
    try {
      const cron = new Cron(schedule.cron);
      // Use lastRunAt as the baseline; if never run, use epoch to fire immediately
      const nextRun = cron.nextRun(schedule.lastRunAt ?? new Date(0));

      if (nextRun && nextRun <= new Date()) {
        await taskQueueService.enqueue({
          taskType: "agent_schedule_run",
          payload: {
            scheduleId: schedule.id,
            agentId: schedule.agentId,
            message: schedule.message,
          },
        });
        logger.info(
          {
            scheduleId: schedule.id,
            agentId: schedule.agentId,
            cron: schedule.cron,
          },
          "[AgentScheduler] Enqueued scheduled agent run",
        );
      }
    } catch (error) {
      // Log and continue — a bad cron or DB error must not break the loop
      logger.warn(
        {
          scheduleId: schedule.id,
          agentId: schedule.agentId,
          cron: schedule.cron,
          error: error instanceof Error ? error.message : String(error),
        },
        "[AgentScheduler] Failed to evaluate agent schedule",
      );
    }
  }
}

/**
 * Agent schedule run handler — executes a single scheduled agent invocation.
 *
 * Receives the payload enqueued by `handleCheckDueAgentSchedules` and
 * calls the agent gateway with the stored message. Updates `lastRunAt`
 * on success so the next cron window advances correctly.
 *
 * Note on A2A invocation:
 *   The agent is invoked via the internal HTTP gateway (same mechanism used
 *   by ChatOps and Email triggers). We POST to the internal A2A endpoint
 *   with the agent ID and message. This avoids importing the full chat
 *   engine into the task-queue layer and keeps the boundary clean.
 */
export async function handleAgentScheduleRun(
  payload: Record<string, unknown>,
): Promise<void> {
  const { scheduleId, agentId, message } = payload as {
    scheduleId: string;
    agentId: string;
    message: string;
  };

  if (!scheduleId || !agentId || !message) {
    throw new Error(
      `[AgentScheduler] Missing required payload fields: scheduleId=${scheduleId}, agentId=${agentId}`,
    );
  }

  const ranAt = new Date();

  try {
    // Invoke the agent via the internal A2A gateway endpoint.
    // This is the same mechanism used by ChatOps and Email triggers,
    // keeping the invocation path consistent across all trigger types.
    const gatewayUrl = process.env.INTERNAL_GATEWAY_URL ?? "http://localhost:3000";
    const response = await fetch(
      `${gatewayUrl}/api/v1/agents/${agentId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: message,
          source: "schedule",
          scheduleId,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Gateway returned ${response.status}: ${await response.text()}`,
      );
    }

    // Advance the cron baseline so next evaluation computes the correct window
    await AgentScheduleModel.markRan(scheduleId, ranAt);

    logger.info(
      { scheduleId, agentId },
      "[AgentScheduler] Scheduled agent run completed",
    );
  } catch (error) {
    logger.error(
      {
        scheduleId,
        agentId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[AgentScheduler] Scheduled agent run failed",
    );
    throw error; // Re-throw so TaskQueue can retry / dead-letter
  }
}
