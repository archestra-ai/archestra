import { and, eq, lte } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { TaskType } from "@/types";
import { scheduleTriggersTable } from "../models/schedule-trigger";
import { scheduleTriggerRunsTable } from "../models/schedule-trigger-run";
import { calculateNextDueAt } from "./utils";

export async function runSchedulerTick(batchSize = 25): Promise<number> {
  let processedCount = 0;

  try {
    await db.transaction(async (tx) => {
      const now = new Date();

      // 0. Reclaim stuck runs (running for > 15 minutes)
      // This handles cases where a worker crashed mid-execution.
      const timeoutThreshold = new Date(now.getTime() - 15 * 60 * 1000);
      const stuckRuns = await tx
        .update(scheduleTriggerRunsTable)
        .set({ status: "pending", startedAt: null })
        .where(
          and(
            eq(scheduleTriggerRunsTable.status, "running"),
            lte(scheduleTriggerRunsTable.startedAt, timeoutThreshold),
          ),
        )
        .returning();

      for (const run of stuckRuns) {
        await tx.insert(schema.tasksTable).values({
          taskType: "schedule_trigger_run_execute" as TaskType,
          payload: { runId: run.id },
          maxAttempts: 5,
        });
        logger.warn(
          { runId: run.id },
          "[Scheduler] Reclaimed stuck run and re-enqueued",
        );
      }

      // Find due triggers, row lock to prevent concurrent workers from fetching the same triggers
      const dueTriggers = await tx
        .select()
        .from(scheduleTriggersTable)
        .where(
          and(
            eq(scheduleTriggersTable.enabled, true),
            lte(scheduleTriggersTable.nextDueAt, now),
          ),
        )
        .limit(batchSize)
        .for("update", { skipLocked: true });

      if (dueTriggers.length === 0) {
        return;
      }

      for (const trigger of dueTriggers) {
        try {
          // Compute the next due date based on the *current* time so we don't spam if we missed ticks
          const nextDueAt = calculateNextDueAt(
            trigger.cronExpression,
            trigger.timezone,
            now,
          );

          // 1. Create run snapshot
          const [run] = await tx
            .insert(scheduleTriggerRunsTable)
            .values({
              triggerId: trigger.id,
              organizationId: trigger.organizationId,
              runKind: "scheduled",
              status: "pending",
              dueAt: trigger.nextDueAt,
              agentIdSnapshot: trigger.agentId,
              messageTemplateSnapshot: trigger.messageTemplate,
              actorUserIdSnapshot: trigger.actorUserId,
              cronExpressionSnapshot: trigger.cronExpression,
              timezoneSnapshot: trigger.timezone,
            })
            .returning();

          // 2. Enqueue execution job atomically
          await tx.insert(schema.tasksTable).values({
            taskType: "schedule_trigger_run_execute" as TaskType,
            payload: { runId: run.id },
            maxAttempts: 5,
          });

          // 3. Update the trigger's next_due_at
          await tx
            .update(scheduleTriggersTable)
            .set({ nextDueAt })
            .where(eq(scheduleTriggersTable.id, trigger.id));

          processedCount++;
        } catch (error: any) {
          // If a duplicate run is attempted (uq_trigger_id_due_at constraint), it means it was already
          // scheduled. We can safely just advance the nextDueAt without failing the batch.
          if (error?.message?.includes("uq_trigger_id_due_at")) {
            const nextDueAt = calculateNextDueAt(
              trigger.cronExpression,
              trigger.timezone,
              now,
            );
            await tx
              .update(scheduleTriggersTable)
              .set({ nextDueAt })
              .where(eq(scheduleTriggersTable.id, trigger.id));
            logger.warn(
              { triggerId: trigger.id },
              "[Scheduler] Prevented duplicate run, advanced nextDueAt",
            );
          } else {
            // Re-throw so the transaction rolls back cleanly for this batch
            throw error;
          }
        }
      }
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "[Scheduler] Tick failed",
    );
  }

  return processedCount;
}
