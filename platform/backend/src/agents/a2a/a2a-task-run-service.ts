import logger from "@/logging";
import { A2ATaskModel } from "@/models";
import type { A2AProtocolStreamResponse } from "./a2a-protocol";

const DELTA_FLUSH_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const STOP_POLL_INTERVAL_MS = 2 * 1000;
const STALE_RUN_MS = 10 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;
const TERMINAL_EVENT_RETENTION_MS = 60 * 60 * 1000;

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
  private reapTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  get shuttingDown(): boolean {
    return this.isShuttingDown;
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

    const ids = Array.from(this.controllers.keys());
    for (const id of ids) {
      this.controllers.get(id)?.abort();
    }
    if (ids.length === 0) {
      return;
    }

    try {
      const failed = await A2ATaskModel.failActiveByIds({
        ids,
        statusReason: SHUTDOWN_TASK_REASON,
        buildEventPayload: (task) => ({
          statusUpdate: {
            taskId: task.id,
            contextId: task.contextId,
            status: { state: "TASK_STATE_FAILED" },
          },
        }),
      });
      if (failed > 0) {
        logger.info({ failed }, "Failed in-flight A2A task runs on shutdown");
      }
    } catch (error) {
      logger.error({ error }, "Failed to fail in-flight A2A task runs");
    }
  }

  /**
   * Reap orphans + prune terminal event logs. Runs on an interval while this
   * pod has active runs, and opportunistically from task reads.
   */
  async reapStale(): Promise<void> {
    try {
      const reaped = await A2ATaskModel.reapStaleRunning({
        staleMs: STALE_RUN_MS,
        statusReason: ORPHANED_TASK_REASON,
        buildEventPayload: (task) => ({
          statusUpdate: {
            taskId: task.id,
            contextId: task.contextId,
            status: { state: "TASK_STATE_FAILED" },
          },
        }),
      });
      if (reaped > 0) {
        logger.info({ reaped }, "Reaped stale A2A task runs");
      }
      await A2ATaskModel.deleteEventsOfTerminalTasksOlderThan(
        TERMINAL_EVENT_RETENTION_MS,
      );
    } catch (error) {
      logger.warn({ error }, "Failed to reap stale A2A task runs");
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

    this.flushChain = this.flushChain.then(async () => {
      const appended = await A2ATaskModel.appendRunDelta({
        taskId: this.params.taskId,
        eventPayload: this.params.buildDeltaEvent(chunk),
        artifact: { ...this.params.artifact, appendText: chunk },
      });
      if (appended === null) {
        this.stopped = true;
        this.params.onTaskNoLongerActive();
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
