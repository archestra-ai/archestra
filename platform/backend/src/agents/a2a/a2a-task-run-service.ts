import config from "@/config";
import logger from "@/logging";
import { A2ATaskModel } from "@/models";
import {
  A2AProtocolRole,
  type A2AProtocolStreamResponse,
} from "./a2a-protocol";
import { a2aPushNotificationService } from "./a2a-push-notification-service";
import { a2aTaskEventNotifier } from "./a2a-task-event-notifier";

const DELTA_FLUSH_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const STOP_POLL_INTERVAL_MS = 2 * 1000;
const STALE_RUN_MS = 10 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;
const TERMINAL_EVENT_RETENTION_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Tasks deleted per sweep, so one tick cannot hold a long transaction. */
const RETENTION_BATCH_SIZE = 500;
/** Batches per tick, bounding how long a single sweep runs. */
const RETENTION_MAX_BATCHES = 10;

const ORPHANED_TASK_REASON =
  "The server executing this task stopped before the run completed.";
const SHUTDOWN_TASK_REASON =
  "The server shut down before the task's run completed.";

/**
 * Process-local lifecycle mechanics for A2A task runs (the durable state
 * machine itself lives in A2ATaskModel; the chat feature's ActiveChatRunService
 * is the blueprint):
 *
 * - an AbortController registry, so a CancelTask landing on the pod that owns
 *   the run aborts it immediately (cross-pod cancellation is observed by the
 *   run's own state poll and delta-append guard);
 * - a per-run delta batcher that coalesces text deltas into bounded appends
 *   (event + artifact + heartbeat in one transaction);
 * - a stop poll + heartbeat timer per run, covering delta-less stretches
 *   (a long silent tool call still heartbeats, and still notices a
 *   cross-pod cancel);
 * - a periodic reaper failing orphaned tasks (pod died hard) and pruning
 *   terminal tasks' event logs after their retention window;
 * - graceful-shutdown handling that fails this pod's in-flight runs.
 */
class A2ATaskRunService {
  private readonly controllers = new Map<string, AbortController>();
  /**
   * Runs whose work is a container rather than a promise here. Held apart from
   * `controllers` so shutdown can leave them alone without losing the ability
   * to cancel one on request — `abortLocal` still reaches them.
   */
  private readonly survivesRestart = new Set<string>();
  private reapTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  /**
   * Start the periodic orphan reaper / event-log pruner. Called once at
   * server boot (like the chat run reaper), so orphaned tasks get settled
   * even on pods that never start a run themselves.
   */
  startMaintenance(): void {
    this.startReapLoopIfNeeded();
  }

  /**
   * Register a run for `taskId`: returns its abort signal plus the batcher
   * that drains text deltas into the durable event/artifact log, and starts
   * the heartbeat/stop-poll loop. Call `finish()` in a finally-block — it
   * stops the timers and releases the registry entry.
   */
  startRun(params: {
    taskId: string;
    /** Built per flush: one coalesced text chunk → one stream event. */
    buildDeltaEvent: (chunk: string) => A2AProtocolStreamResponse;
    artifact: { id: string; name: string };
    /**
     * The work outlives this process — it is a Kubernetes Job, not a promise
     * on this event loop. Such a run must survive shutdown untouched: failing
     * it would lie about a container that is still working, and aborting it
     * would tear that container down mid-task on every rolling deploy.
     */
    survivesRestart?: boolean;
  }): {
    signal: AbortSignal;
    onTextDelta: (delta: string) => void;
    /** Resolves once every queued delta append settled. */
    drainDeltas: () => Promise<void>;
    finish: () => void;
  } {
    const { taskId } = params;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    if (params.survivesRestart) {
      this.survivesRestart.add(taskId);
    }
    this.startReapLoopIfNeeded();

    const batcher = new A2ATaskDeltaBatcher({
      taskId,
      buildDeltaEvent: params.buildDeltaEvent,
      artifact: params.artifact,
      onTaskNoLongerActive: () => {
        // The delta-append guard found the task outside SUBMITTED/WORKING:
        // canceled cross-pod, or reaped. Stop producing.
        if (!controller.signal.aborted) {
          controller.abort();
        }
      },
    });

    // Heartbeat + cross-pod stop poll. One interval serves both: touch the
    // row's liveness, and observe a state another pod moved to CANCELED.
    let pollTick = 0;
    const poller = setInterval(async () => {
      if (controller.signal.aborted) {
        return;
      }
      try {
        pollTick += 1;
        const task = await A2ATaskModel.findById(taskId);
        // Anything other than an active run state means this run no longer
        // owns the task — canceled cross-pod, reaped to FAILED, or the row is
        // gone. Stop burning model/tool resources either way.
        if (
          !task ||
          (task.state !== "TASK_STATE_SUBMITTED" &&
            task.state !== "TASK_STATE_WORKING")
        ) {
          controller.abort();
          return;
        }
        if (
          pollTick %
            Math.ceil(HEARTBEAT_INTERVAL_MS / STOP_POLL_INTERVAL_MS) ===
          0
        ) {
          await A2ATaskModel.touchHeartbeat(taskId);
        }
      } catch (error) {
        logger.warn({ error, taskId }, "A2A task run poll failed");
      }
    }, STOP_POLL_INTERVAL_MS);
    poller.unref?.();

    return {
      signal: controller.signal,
      onTextDelta: (delta) => batcher.write(delta),
      drainDeltas: () => batcher.flush(),
      finish: () => {
        clearInterval(poller);
        batcher.dispose();
        this.controllers.delete(taskId);
        this.survivesRestart.delete(taskId);
      },
    };
  }

  /** Abort the run for `taskId` when it lives on this pod. */
  abortLocal(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }

  /**
   * Fail whatever this pod is still running, so clients are not left polling
   * WORKING tasks that will never settle. Called from the server's onClose.
   */
  async failInFlightRuns(): Promise<void> {
    this.isShuttingDown = true;
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }

    // A run whose work lives in a container is left exactly as it is: still
    // WORKING, still heartbeating from the pod, ready for another replica to
    // follow. Its Job does not know this process existed.
    const allIds = Array.from(this.controllers.keys());
    const ids = allIds.filter((id) => !this.survivesRestart.has(id));
    const surviving = allIds.length - ids.length;
    if (surviving > 0) {
      logger.info(
        { surviving },
        "Left container-backed A2A task runs running through shutdown",
      );
    }
    if (ids.length === 0) {
      return;
    }

    // Settle FIRST, abort second: if the aborts ran first, each run's own
    // catch would race this write and settle its task CANCELED — but a
    // shutdown is a failure of the server, not a client cancellation.
    try {
      const failed = await A2ATaskModel.failActiveByIds({
        ids,
        statusReason: SHUTDOWN_TASK_REASON,
        buildEventPayload: (task) =>
          buildFailedEventPayload(task, SHUTDOWN_TASK_REASON),
      });
      if (failed > 0) {
        logger.info({ failed }, "Failed in-flight A2A task runs on shutdown");
      }
    } catch (error) {
      logger.error({ error }, "Failed to fail in-flight A2A task runs");
    }

    for (const id of ids) {
      this.controllers.get(id)?.abort();
    }
  }

  /**
   * Push one persisted stream event to the task's registered webhooks.
   * Fire-and-forget: the event log is the durable record, so a webhook that
   * is down costs push updates, never the task's outcome.
   */
  notify(taskId: string, event: A2AProtocolStreamResponse): void {
    void a2aPushNotificationService.deliver({ taskId, event });
    this.wakeSubscribers(taskId);
  }

  /**
   * Tell every replica's SubscribeToTask streams that this task has new
   * events, so they re-read now instead of on their next poll. Best-effort by
   * design: the poll is what makes the stream correct.
   */
  wakeSubscribers(taskId: string): void {
    void a2aTaskEventNotifier.notify(taskId).catch((error) => {
      logger.warn(
        { error, taskId },
        "Failed to publish an A2A task event notification",
      );
    });
  }

  /** Reap orphans + prune terminal event logs (one interval tick). */
  async reapStale(): Promise<void> {
    try {
      const reaped = await A2ATaskModel.reapStaleRunning({
        staleMs: STALE_RUN_MS,
        statusReason: ORPHANED_TASK_REASON,
        buildEventPayload: (task) =>
          buildFailedEventPayload(task, ORPHANED_TASK_REASON),
      });
      if (reaped > 0) {
        logger.info({ reaped }, "Reaped stale A2A task runs");
      }
      // Stream events are transport, not the record: nothing can subscribe
      // to a task that settled an hour ago, so their events are dead weight.
      await A2ATaskModel.deleteEventsOfTerminalTasksOlderThan(
        TERMINAL_EVENT_RETENTION_MS,
      );

      await this.sweepExpiredTasks();
    } catch (error) {
      logger.warn({ error }, "Failed to reap stale A2A task runs");
    }
  }

  /**
   * Delete terminal tasks past the configured retention window. Runs in
   * bounded batches so a backlog is worked down over several ticks instead of
   * one enormous transaction.
   */
  private async sweepExpiredTasks(): Promise<void> {
    const retentionDays = config.a2aV2Gateway.taskRetentionDays;
    if (retentionDays <= 0) {
      return;
    }

    let deleted = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
      const removed = await A2ATaskModel.deleteTerminalTasksOlderThan({
        retentionMs: retentionDays * DAY_MS,
        batchSize: RETENTION_BATCH_SIZE,
      });
      deleted += removed;
      if (removed < RETENTION_BATCH_SIZE) {
        break;
      }
    }

    if (deleted > 0) {
      logger.info(
        { deleted, retentionDays },
        "Deleted expired A2A tasks past their retention window",
      );
    }
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private startReapLoopIfNeeded(): void {
    if (this.reapTimer || this.isShuttingDown) {
      return;
    }
    this.reapTimer = setInterval(() => {
      void this.reapStale();
    }, REAP_INTERVAL_MS);
    this.reapTimer.unref?.();
  }
}

export const a2aTaskRunService = new A2ATaskRunService();

/**
 * Terminal FAILED event carrying its reason as the status message, so
 * stream followers see the same diagnostics GetTask serves.
 */
function buildFailedEventPayload(
  task: { id: string; contextId: string },
  reason: string,
): A2AProtocolStreamResponse {
  return {
    statusUpdate: {
      taskId: task.id,
      contextId: task.contextId,
      status: {
        state: "TASK_STATE_FAILED",
        message: {
          messageId: `${task.id}-status`,
          contextId: task.contextId,
          taskId: task.id,
          role: A2AProtocolRole.Agent,
          parts: [{ text: reason }],
        },
      },
    },
  };
}

/**
 * Coalesces the executor's token-level text deltas into bounded chunks and
 * appends each chunk transactionally (event + artifact append + heartbeat).
 * Serialized on one promise chain so appends — and therefore event sequence
 * numbers — retain generation order.
 */
class A2ATaskDeltaBatcher {
  private pending = "";
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly params: {
      taskId: string;
      buildDeltaEvent: (chunk: string) => A2AProtocolStreamResponse;
      artifact: { id: string; name: string };
      onTaskNoLongerActive: () => void;
    },
  ) {}

  write(delta: string): void {
    if (this.stopped || delta.length === 0) {
      return;
    }
    this.pending += delta;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        void this.flush().catch((error) => {
          logger.warn(
            { error, taskId: this.params.taskId },
            "A2A task delta flush failed",
          );
        });
      }, DELTA_FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const chunk = this.pending;
    this.pending = "";
    if (chunk.length === 0 || this.stopped) {
      return await this.flushChain;
    }

    // The chain must always settle resolved: a transient append failure only
    // degrades streaming for that chunk (logged and dropped) — it must never
    // leave the chain rejected (every later flush would rethrow it, and the
    // lifecycle's drain would misclassify a successful run as FAILED). Losing
    // a chunk is safe because the completion transaction seals the artifact
    // with the authoritative full content.
    this.flushChain = this.flushChain.then(async () => {
      try {
        const appended = await A2ATaskModel.appendRunDelta({
          taskId: this.params.taskId,
          eventPayload: this.params.buildDeltaEvent(chunk),
          artifact: { ...this.params.artifact, appendText: chunk },
        });
        if (appended === null) {
          this.stopped = true;
          this.params.onTaskNoLongerActive();
          return;
        }
        // The chunk is durable now, so subscribers on any replica can read it.
        a2aTaskRunService.wakeSubscribers(this.params.taskId);
      } catch (error) {
        logger.warn(
          { error, taskId: this.params.taskId },
          "Failed to persist an A2A task delta chunk; dropping it",
        );
      }
    });

    return await this.flushChain;
  }

  dispose(): void {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
