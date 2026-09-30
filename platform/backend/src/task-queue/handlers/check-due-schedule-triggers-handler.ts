import logger from "@/logging";
import {
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  TaskModel,
} from "@/models";
import { metrics } from "@/observability";
import { failDetachedAgentTask } from "@/services/agent-runtime/start-task";
import { taskQueueService } from "@/task-queue";
import { isTerminalA2ATaskState } from "@/types/a2a-task";

export async function handleCheckDueScheduleTriggers(): Promise<void> {
  const runtimeRuns = await ScheduleTriggerRunModel.findRunningRuntimeTasks();
  // The unfinished run of each trigger, replaced or named when it is due.
  const activeRuntimeRuns = new Map<string, ActiveRuntimeRun>();
  for (const run of runtimeRuns) {
    if (run.state && run.runtimeTaskId && !isTerminalA2ATaskState(run.state)) {
      activeRuntimeRuns.set(run.triggerId, {
        runId: run.runId,
        taskId: run.runtimeTaskId,
        agentName: run.agentName,
        startedAt: run.startedAt ?? run.createdAt,
      });
      continue;
    }
    const status =
      run.state === "TASK_STATE_COMPLETED"
        ? "success"
        : run.state === "TASK_STATE_CANCELED"
          ? "cancelled"
          : "failed";
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
      const previousRun = activeRuntimeRuns.get(trigger.id);
      const longestSuccessMs = previousRun
        ? await ScheduleTriggerRunModel.findLongestRecentSuccessMs(trigger.id)
        : null;
      // Replace a run only when it has already taken longer than every recent
      // successful run, so a normal run longer than the interval can finish.
      const replacePreviousRun =
        previousRun !== undefined &&
        longestSuccessMs !== null &&
        now.getTime() - previousRun.startedAt.getTime() > longestSuccessMs;
      if (
        activeTriggerIds.has(trigger.id) ||
        (previousRun && !replacePreviousRun)
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
          error: previousRun
            ? skippedForRuntimeRun({ ...previousRun, now })
            : "Skipped: the previous run was still starting.",
        });
        await ScheduleTriggerModel.markExecuted(trigger.id, now);
        continue;
      }

      const run = await ScheduleTriggerRunModel.create({
        organizationId: trigger.organizationId,
        triggerId: trigger.id,
        runKind: "due",
      });

      if (previousRun && longestSuccessMs !== null) {
        await replaceRuntimeRun({
          previousRun,
          replacementRunId: run.id,
          longestSuccessMs,
          now,
        });
      }

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

// =============================================================================
// Internal
// =============================================================================

interface ActiveRuntimeRun {
  runId: string;
  taskId: string;
  agentName: string | null;
  startedAt: Date;
}

/**
 * Stop a run that is still in progress at its trigger's next due time. The
 * task fails with a reason naming the replacement, and the Agent Runtime
 * reconciler stops its workload. A task that finished in the meantime keeps
 * its own outcome, which the next tick records.
 */
async function replaceRuntimeRun(params: {
  previousRun: ActiveRuntimeRun;
  replacementRunId: string;
  longestSuccessMs: number;
  now: Date;
}): Promise<void> {
  const { previousRun } = params;
  const reason = `Replaced by run ${params.replacementRunId}: this run was still in progress at the next scheduled time (started ${previousRun.startedAt.toISOString()}, ${formatMinutes(elapsedMinutes(previousRun.startedAt, params.now))} ago). Recent successful runs took at most ${formatMinutes(Math.ceil(params.longestSuccessMs / 60_000))}.`;
  const failed = await failDetachedAgentTask({
    taskId: previousRun.taskId,
    statusReason: reason,
  });
  if (!failed) return;
  const completed = await ScheduleTriggerRunModel.markCompleted({
    runId: previousRun.runId,
    status: "failed",
    error: reason,
  });
  if (completed)
    metrics.scheduleTrigger.reportScheduleTriggerRun(
      previousRun.agentName ?? "unknown",
      "failed",
    );
  logger.info(
    {
      runId: previousRun.runId,
      taskId: previousRun.taskId,
      replacementRunId: params.replacementRunId,
    },
    "Replaced unfinished scheduled runtime run",
  );
}

function skippedForRuntimeRun(params: {
  runId: string;
  startedAt: Date;
  now: Date;
}): string {
  return `Skipped: run ${params.runId} was still in progress (started ${params.startedAt.toISOString()}, ${formatMinutes(elapsedMinutes(params.startedAt, params.now))} ago). A run that does not finish is stopped at the agent's Maximum duration.`;
}

function elapsedMinutes(startedAt: Date, now: Date): number {
  return Math.floor((now.getTime() - startedAt.getTime()) / 60_000);
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
