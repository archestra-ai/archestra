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

  for (const trigger of dueTriggers) {
    try {
      const exists = await TaskModel.hasPendingOrProcessingForTrigger(
        "schedule_trigger_run_execute",
        trigger.id,
      );

      if (exists) {
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
        continue;
      }

      const run = await ScheduleTriggerRunModel.create({
        organizationId: trigger.organizationId,
        triggerId: trigger.id,
        runKind: "due",
      });

      await ScheduleTriggerModel.markExecuted(trigger.id, now);

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
