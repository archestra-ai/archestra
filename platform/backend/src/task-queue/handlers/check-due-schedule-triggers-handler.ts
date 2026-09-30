import config from "@/config";
import logger from "@/logging";
import {
  AgentRunModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  TaskModel,
} from "@/models";
import { metrics } from "@/observability";
import { cleanupAgentRun } from "@/services/agent-runtime/pod-run";
import { failDetachedAgentTask } from "@/services/agent-runtime/start-task";
import { taskQueueService } from "@/task-queue";
import { isTerminalA2ATaskState } from "@/types/a2a-task";

export async function handleCheckDueScheduleTriggers(): Promise<void> {
  const now = new Date();
  const runtimeRuns = await ScheduleTriggerRunModel.findRunningRuntimeTasks();
  // The unfinished run that blocks each trigger, named in a skip record.
  const activeRuntimeRuns = new Map<
    string,
    { runId: string; startedAt: Date }
  >();
  for (const run of runtimeRuns) {
    if (run.state && !isTerminalA2ATaskState(run.state)) {
      const startedAt = run.startedAt ?? run.createdAt;
      const overdue =
        now.getTime() - startedAt.getTime() >=
        config.agentRuntime.scheduledRunTimeoutMinutes * 60_000;
      if (!overdue || (await stopOverdueRun(run))) {
        activeRuntimeRuns.set(run.triggerId, { runId: run.runId, startedAt });
      }
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

  const dueTriggers = await ScheduleTriggerModel.findDueTriggers(now);
  if (dueTriggers.length === 0) return;

  // One query instead of a per-trigger EXISTS check.
  const activeTriggerIds = await TaskModel.findActivePayloadValues(
    "schedule_trigger_run_execute",
    "triggerId",
  );

  for (const trigger of dueTriggers) {
    try {
      const blockingRuntimeRun = activeRuntimeRuns.get(trigger.id);
      if (activeTriggerIds.has(trigger.id) || blockingRuntimeRun) {
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
          error: blockingRuntimeRun
            ? skippedForRuntimeRun({ ...blockingRuntimeRun, now })
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

/**
 * Stop a scheduled runtime run that outlived its limit: fail its task, stop
 * the workload, and settle the scheduled run. Returns whether the run still
 * blocks its schedule: only when stopping it failed. A task that settled
 * underneath us no longer blocks; the next tick records its outcome.
 */
async function stopOverdueRun(run: {
  runId: string;
  runtimeTaskId: string | null;
  agentName: string | null;
}): Promise<boolean> {
  if (!run.runtimeTaskId) return false;
  const reason = `The scheduled run was stopped after ${formatMinutes(
    config.agentRuntime.scheduledRunTimeoutMinutes,
  )}, its time limit.`;
  let failed: boolean;
  try {
    failed = await failDetachedAgentTask({
      taskId: run.runtimeTaskId,
      statusReason: reason,
    });
  } catch (error) {
    logger.warn(
      { error, runId: run.runId, taskId: run.runtimeTaskId },
      "Could not stop an overdue scheduled run; will retry next tick",
    );
    return true;
  }
  if (!failed) return false;

  logger.warn(
    { runId: run.runId, taskId: run.runtimeTaskId },
    "Stopped a scheduled Agent Runtime run that exceeded its time limit",
  );
  // The reconciler retries cleanup for any run still open, so a failure here
  // must not keep the schedule blocked.
  const session = await AgentRunModel.findByTaskId(run.runtimeTaskId);
  if (session) {
    await cleanupAgentRun(session, { requireTranscript: true }).catch((error) =>
      logger.warn(
        { error, taskId: run.runtimeTaskId },
        "Cleanup of a stopped scheduled run will retry",
      ),
    );
  }
  const completed = await ScheduleTriggerRunModel.markCompleted({
    runId: run.runId,
    status: "failed",
    error: reason,
  });
  if (completed)
    metrics.scheduleTrigger.reportScheduleTriggerRun(
      run.agentName ?? "unknown",
      "failed",
    );
  return false;
}

function skippedForRuntimeRun(params: {
  runId: string;
  startedAt: Date;
  now: Date;
}): string {
  const elapsedMinutes = Math.floor(
    (params.now.getTime() - params.startedAt.getTime()) / 60_000,
  );
  return `Skipped: run ${params.runId} was still in progress (started ${params.startedAt.toISOString()}, ${formatMinutes(elapsedMinutes)} ago). A scheduled run is stopped after ${formatMinutes(config.agentRuntime.scheduledRunTimeoutMinutes)}.`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
