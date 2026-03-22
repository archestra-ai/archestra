import { and, eq, lte, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { TaskType } from "@/types";
import { agentScheduleTriggersTable } from "../models/agent-schedule-trigger";
import { agentScheduleTriggerRunsTable } from "../models/agent-schedule-trigger-run";
import { calculateNextDueAt } from "./utils";

const MAX_CATCH_UP_SLOTS_PER_TICK = 10;
const MAX_BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function runSchedulerTick(batchSize = 50): Promise<number> {
  let totalRunsCreated = 0;

  try {
    await db.transaction(async (tx) => {
      const now = new Date();

      // 0. Reclaim stuck runs (running for > 30 minutes)
      const timeoutThreshold = new Date(now.getTime() - 30 * 60 * 1000);
      const stuckRuns = await tx
        .update(agentScheduleTriggerRunsTable)
        .set({ status: "pending", startedAt: null })
        .where(
          and(
            eq(agentScheduleTriggerRunsTable.status, "running"),
            lte(agentScheduleTriggerRunsTable.startedAt, timeoutThreshold),
          ),
        )
        .returning();

      for (const run of stuckRuns) {
        await tx.insert(schema.tasksTable).values({
          taskType: "schedule_trigger_run_execute" as TaskType,
          payload: { runId: run.id },
          maxAttempts: 5,
        });
      }

      // 1. Find due triggers
      const dueTriggers = await tx
        .select()
        .from(agentScheduleTriggersTable)
        .where(
          and(
            eq(agentScheduleTriggersTable.enabled, true),
            lte(agentScheduleTriggersTable.nextDueAt, now),
          ),
        )
        .limit(batchSize)
        .for("update", { skipLocked: true });

      for (const trigger of dueTriggers) {
        let currentDueAt = new Date(trigger.nextDueAt!);
        let slotsProcessed = 0;

        // Bounded catch-up: process up to X slots that are <= now
        // and within the last 24 hours.
        const backfillLimit = new Date(now.getTime() - MAX_BACKFILL_WINDOW_MS);
        if (currentDueAt < backfillLimit) {
          logger.warn(
            { triggerId: trigger.id, missedSince: currentDueAt },
            "[AgentScheduler] Trigger is severely overdue, skipping old slots",
          );
          currentDueAt = backfillLimit;
          // Calculate the first valid cron occurrence after the backfill limit
          const firstValid = calculateNextDueAt(
            trigger.cronExpression,
            trigger.timezone,
            new Date(backfillLimit.getTime() - 1000), // -1s to include backfillLimit if it matches
          );
          if (!firstValid) continue;
          currentDueAt = firstValid;
        }

        while (currentDueAt <= now && slotsProcessed < MAX_CATCH_UP_SLOTS_PER_TICK) {
          try {
            // 2. Create one run per missed due slot
            const [run] = await tx
              .insert(agentScheduleTriggerRunsTable)
              .values({
                triggerId: trigger.id,
                organizationId: trigger.organizationId,
                runKind: "scheduled",
                status: "pending",
                dueAt: currentDueAt,
                agentIdSnapshot: trigger.agentId,
                messageTemplateSnapshot: trigger.messageTemplate,
                actorUserIdSnapshot: trigger.actorUserId,
                cronExpressionSnapshot: trigger.cronExpression,
                timezoneSnapshot: trigger.timezone,
              })
              .returning();

            // 3. Enqueue execution
            await tx.insert(schema.tasksTable).values({
              taskType: "schedule_trigger_run_execute" as TaskType,
              payload: { runId: run.id },
              maxAttempts: 5,
            });

            totalRunsCreated++;
            slotsProcessed++;
            
            // Advance to next slot
            const next = calculateNextDueAt(
              trigger.cronExpression,
              trigger.timezone,
              currentDueAt,
            );
            if (!next) break;
            currentDueAt = next;
          } catch (error: any) {
            if (error?.message?.includes("uq_agent_trigger_id_due_at")) {
              // Already exists, just advance and try next slot
              const next = calculateNextDueAt(trigger.cronExpression, trigger.timezone, currentDueAt);
              if (!next) break;
              currentDueAt = next;
              continue;
            }
            throw error;
          }
        }

        // 4. Update the trigger's next_due_at to the first future/next occurrence
        await tx
          .update(agentScheduleTriggersTable)
          .set({ nextDueAt: currentDueAt, lastRunAt: now })
          .where(eq(agentScheduleTriggersTable.id, trigger.id));
      }
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "[AgentScheduler] Tick failed",
    );
  }

  return totalRunsCreated;
}
