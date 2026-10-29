import logger from "@/logging";
import { ScheduleTriggerModel, ScheduleTriggerRunModel } from "@/models";
import { metrics } from "@/observability";
import { isTerminalA2ATaskState } from "@/types/a2a-task";
import type { ScheduleRunBlocker } from "@/types/schedule-trigger";

export async function handleCheckDueScheduleTriggers(): Promise<void> {
  const now = new Date();
  const runtimeRuns = await ScheduleTriggerRunModel.findRunningRuntimeTasks();
  const blockers = new Map<string, ScheduleRunBlocker>();
  for (const run of runtimeRuns) {
    const working = run.state && !isTerminalA2ATaskState(run.state);
    // A terminal task is durable before its workload has acknowledged Stop.
    // Keep this schedule blocked until cleanup closes the runtime record.
    const stopping = !!run.runtimeRunId && !run.endedAt;
    if (working || stopping) {
      const startedAt = run.startedAt ?? run.createdAt;
      blockers.set(run.triggerId, {
        phase: working ? "running" : "stopping",
        runId: run.runId,
        runtimeTaskId: run.runtimeTaskId,
        startedAt: startedAt.toISOString(),
        elapsedSeconds: Math.max(
          0,
          Math.floor((now.getTime() - startedAt.getTime()) / 1000),
        ),
        deadline: run.deadline?.toISOString() ?? null,
        maximumDurationSeconds: run.maximumDurationSeconds,
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

  const dueTriggers = await ScheduleTriggerModel.findDueTriggers(now);
  if (dueTriggers.length === 0) return;
  for (const queued of await ScheduleTriggerRunModel.findQueuedExecutions()) {
    if (!queued.triggerId || blockers.has(queued.triggerId)) continue;
    blockers.set(queued.triggerId, {
      phase: queued.chatConversationId ? "running" : "starting",
      runId: queued.runId,
      runtimeTaskId: null,
      startedAt: queued.startedAt.toISOString(),
      elapsedSeconds: Math.max(
        0,
        Math.floor((now.getTime() - queued.startedAt.getTime()) / 1000),
      ),
      deadline: null,
      maximumDurationSeconds: null,
    });
  }

  for (const trigger of dueTriggers) {
    try {
      const blockedBy = blockers.get(trigger.id);
      const run = await ScheduleTriggerRunModel.recordDueRun({
        trigger,
        now,
        ...(blockedBy
          ? { skip: { blockedBy, error: describeBlocker(blockedBy) } }
          : {}),
      });
      if (!run) continue;
      if (!blockedBy)
        metrics.taskQueue.reportTaskEnqueued("schedule_trigger_run_execute");
      logger.info(
        {
          triggerId: trigger.id,
          runId: run.id,
          blockingRunId: blockedBy?.runId,
        },
        blockedBy
          ? "Skipped scheduled tick because previous work is unfinished"
          : "Enqueued scheduled trigger run",
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

// === Internal ===

function describeBlocker(blocker: ScheduleRunBlocker): string {
  const run = blocker.runId ? `run ${blocker.runId}` : "the previous run";
  const elapsed = formatDuration(blocker.elapsedSeconds);
  if (blocker.phase === "starting")
    return `Skipped: ${run} was queued or starting (waiting ${elapsed}, since ${blocker.startedAt}). A runtime's Maximum duration deadline is available after launch. Inspect the earlier run before starting more work.`;
  if (blocker.phase === "stopping")
    return `Skipped: ${run} was still stopping after ${elapsed}. The next scheduled run waits until workload cleanup is confirmed. Open the blocking run to inspect its status.`;
  const bound = blocker.deadline
    ? ` Its Maximum duration deadline is ${blocker.deadline}${blocker.maximumDurationSeconds ? ` (${formatDuration(blocker.maximumDurationSeconds)} maximum)` : ""}.`
    : blocker.runtimeTaskId
      ? " Its Maximum duration deadline is not available yet."
      : " This run executes in chat; runtime Maximum duration does not apply.";
  return `Skipped: ${run} was still in progress (started ${blocker.startedAt}, running for ${elapsed}).${bound} Open the blocking run to inspect or stop it; adjust the agent's Maximum duration for future runs.`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return "less than 1 min";
  const hours = Math.floor(minutes / 60);
  return hours
    ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`
    : `${minutes} min`;
}
