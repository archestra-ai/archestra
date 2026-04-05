import { Cron } from "croner";
import db from "@/database";
import logger from "@/logging";
import { AgentScheduleModel, TaskModel } from "@/models";
import { taskQueueService } from "@/task-queue";

/**
 * Periodically scans for Agent Schedule Triggers that are due for execution.
 * 
 * Uses Postgres Advisory Locks to ensure that only one worker processes a given trigger
 * at a time, even in distributed environments.
 */
export async function handleCheckDueAgents(): Promise<void> {
  // 1. Get all triggers that are active and due (nextRunAt <= now)
  const triggers = await AgentScheduleModel.listDueTriggers();

  for (const trigger of triggers) {
    try {
      // Use a transaction for the advisory lock to be auto-released on commit/rollback
      await db.transaction(async (tx) => {
        // 2. Try to acquire transaction-level lock for this trigger
        const locked = await AgentScheduleModel.acquireTriggerLock(trigger.id, tx);
        if (!locked) {
          // Another worker is already processing this trigger
          return;
        }

        // 3. Re-fetch inside transaction to ensure we have the latest state
        // and nobody else updated nextRunAt between listDueTriggers and lock acquisition
        const currentTrigger = await AgentScheduleModel.getTrigger(trigger.id, tx);
        const now = new Date();

        if (
          !currentTrigger ||
          currentTrigger.status !== "active" ||
          (currentTrigger.nextRunAt && currentTrigger.nextRunAt > now)
        ) {
          return;
        }

        // 4. Calculate next run time using croner
        const cron = new Cron(currentTrigger.cron, {
          timezone: currentTrigger.timezone ?? undefined,
        });
        const nextRunAt = cron.next(now);

        // 5. Update trigger status before enqueued execution to prevent duplicate triggers
        await AgentScheduleModel.updateTrigger(
          currentTrigger.id,
          {
            nextRunAt,
            lastRunAt: now,
          },
          tx,
        );

        // 6. Handle Overlap Policy
        const { pending, processing } =
          await TaskModel.countPendingOrProcessingAgentExecution(
            currentTrigger.id,
          );

        const isRunning = pending > 0 || processing > 0;

        if (isRunning) {
          if (currentTrigger.overlapPolicy === "skip") {
            logger.info(
              { triggerId: currentTrigger.id, agentId: currentTrigger.agentId },
              "Skipping agent execution due to overlap policy (skip)",
            );
            return;
          }

          if (currentTrigger.overlapPolicy === "buffer_one" && pending > 0) {
            logger.info(
              { triggerId: currentTrigger.id, agentId: currentTrigger.agentId },
              "Skipping agent execution due to overlap policy (buffer_one) - already has a pending task",
            );
            return;
          }
        }

        // 7. Enqueue the actual execution task
        await taskQueueService.enqueue(
          {
            taskType: "agent_execution",
            payload: { triggerId: currentTrigger.id },
          },
          tx,
        );

        logger.info(
          {
            triggerId: currentTrigger.id,
            agentId: currentTrigger.agentId,
            nextRunAt,
          },
          "Successfully scheduled agent execution",
        );
      });
    } catch (error) {
      logger.error(
        {
          triggerId: trigger.id,
          agentId: trigger.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to process due agent trigger",
      );
    }
  }
}
