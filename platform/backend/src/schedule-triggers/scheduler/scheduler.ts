import { and, eq, lte } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { TaskType } from "@/types";
import { agentScheduleTriggersTable } from "../models/agent-schedule-trigger";
import { agentScheduleTriggerRunsTable } from "../models/agent-schedule-trigger-run";
import { calculateNextDueAt } from "./utils";

export async function runSchedulerTick(batchSize = 50): Promise<number> {
  let processedCount = 0;

  try {
    await db.transaction(async (tx) => {
      const now = new Date();

      // 0. Reclaim stuck runs (running for > 30 minutes)
      // Robust engine: reclaimed runs are returned to pending and re-enqueued.
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
        logger.warn(
          { runId: run.id },
          "[AgentScheduler] Reclaimed stuck run and re-enqueued",
        );
      }

      // 1. Find due triggers
      // We use FOR UPDATE SKIP LOCKED to ensure horizontal scalability.
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

      if (dueTriggers.length === 0) {
        return;
      }

      for (const trigger of dueTriggers) {
        try {
          // Compute the next due date. 
          // If we missed multiple cycles, we catch up by scheduling the MOST RECENT missed run,
          // then resetting nextDueAt to the future run relative to 'now'.
          const nextDueAt = calculateNextDueAt(
            trigger.cronExpression,
            trigger.timezone,
            now,
          );

          // 2. Create immutable run snapshot
          const [run] = await tx
            .insert(agentScheduleTriggerRunsTable)
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

          // 3. Atomic Enqueue
          await tx.insert(schema.tasksTable).values({
            taskType: "schedule_trigger_run_execute" as TaskType,
            payload: { runId: run.id },
            maxAttempts: 5,
          });

          // 4. Update the trigger
          await tx
            .update(agentScheduleTriggersTable)
            .set({ nextDueAt, lastRunAt: now })
            .where(eq(agentScheduleTriggersTable.id, trigger.id));

          processedCount++;
        } catch (error: any) {
          // Idempotency: Skip if uq_agent_trigger_id_due_at violated
          if (error?.message?.includes("uq_agent_trigger_id_due_at")) {
             const nextDueAt = calculateNextDueAt(trigger.cronExpression, trigger.timezone, now);
             await tx.update(agentScheduleTriggersTable).set({ nextDueAt }).where(eq(agentScheduleTriggersTable.id, trigger.id));
             logger.info({ triggerId: trigger.id }, "[AgentScheduler] Skipped duplicate run for timestamp");
          } else {
            logger.error({ triggerId: trigger.id, error: error.message }, "[AgentScheduler] Failed to schedule trigger");
            // Continue to next trigger instead of failing the whole batch
          }
        }
      }
    });
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "[AgentScheduler] Tick failed");
  }

  return processedCount;
}
