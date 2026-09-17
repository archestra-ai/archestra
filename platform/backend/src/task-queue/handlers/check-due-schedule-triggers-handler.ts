import logger from "@/logging";
import {
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  TaskModel,
} from "@/models";
import { metrics } from "@/observability";
import { taskQueueService } from "@/task-queue";
import { isTerminalA2ATaskState } from "@/types/a2a-task";

export async function handleCheckDueScheduleTriggers(): Promise<void> {
  const runtimeRuns = await ScheduleTriggerRunModel.findRunningRuntimeTasks();
  const activeRuntimeTriggerIds = new Set<string>();
  for (const run of runtimeRuns) {
    if (run.state && !isTerminalA2ATaskState(run.state)) {
      activeRuntimeTriggerIds.add(run.triggerId);
      continue;
    }
    const status = run.state === "TASK_STATE_COMPLETED" ? "success" : "failed";
    const completed = await ScheduleTriggerRunModel.markCompleted({
      runId: run.runId,
      status,
      error:
        status === "success"
          ? null
          : (run.statusReason ??
            (run.state
              ? `Agent runtime task ended in ${run.state}`
              : "Agent runtime task no longer exists")),
    });
    if (completed)
      metrics.scheduleTrigger.reportScheduleTriggerRun(
        run.agentName ?? "unknown",
        status,
      );
  }

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
      if (
        activeTriggerIds.has(trigger.id) ||
        activeRuntimeTriggerIds.has(trigger.id)
      ) {
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
