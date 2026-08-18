import logger from "@/logging";
import {
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  TaskModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";

export async function handleCheckDueScheduleTriggers(): Promise<void> {
  const now = new Date();
  const dueTriggers = await ScheduleTriggerModel.findDueTriggers(now);
  if (dueTriggers.length === 0) return;

  // One query instead of a per-trigger EXISTS check.
  const activeTriggerIds = await TaskModel.findActivePayloadValues(
    "schedule_trigger_run_execute",
    "triggerId",
  );

  for (const trigger of dueTriggers) {
    try {
      if (activeTriggerIds.has(trigger.id)) {
        logger.debug(
          { triggerId: trigger.id, triggerName: trigger.name },
          "Skipping due trigger, task already in flight",
        );
        const skippedRun = await ScheduleTriggerRunModel.create({
          organizationId: trigger.organizationId,
          triggerId: trigger.id,
          runKind: "due",
        });
        await ScheduleTriggerRunModel.markCompleted({
          runId: skippedRun.id,
          status: "failed",
          error: "Skipped: previous run was still in progress",
        });
        await ScheduleTriggerModel.markExecuted(trigger.id, now);
        // A skipped one-shot is still spent (markExecuted stops any re-fire);
        // disable it too so it never lingers as enabled-but-dead.
        if (trigger.runAt !== null) {
          await ScheduleTriggerModel.update(trigger.id, { enabled: false });
        }
        continue;
      }

      const run = await ScheduleTriggerRunModel.create({
        organizationId: trigger.organizationId,
        triggerId: trigger.id,
        runKind: "due",
      });

      await ScheduleTriggerModel.markExecuted(trigger.id, now);

      // A one-shot (`runAt`) trigger just fired: `lastExecutedAt` alone
      // already prevents a re-fire, but disabling makes the row read as
      // spent everywhere it is listed.
      if (trigger.runAt !== null) {
        await ScheduleTriggerModel.update(trigger.id, { enabled: false });
      }

      await taskQueueService.enqueue({
        taskType: "schedule_trigger_run_execute",
        payload: { runId: run.id, triggerId: trigger.id },
      });

      logger.info(
        {
          triggerId: trigger.id,
          triggerName: trigger.name,
          runId: run.id,
        },
        "Enqueued scheduled trigger run",
      );
    } catch (error) {
      logger.warn(
        {
          triggerId: trigger.id,
          triggerName: trigger.name,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to process due schedule trigger",
      );
    }
  }
}
