import config from "@/config";
import logger from "@/logging";
import { TaskModel } from "@/models";
import * as metrics from "@/observability/metrics";
import type { InsertTask, Task, TaskHandler } from "@/types";
import PERIODIC_TASK_DEFINITIONS from "./periodic-tasks";

export class TaskQueueService {
  private handlers = new Map<string, TaskHandler>();
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private activeTaskIds = new Set<string>();
  private stopping = false;
  private pollInFlight: Promise<void> | null = null;
  private lastStuckSweepAt = 0;
  private drainResolve: (() => void) | null = null;

  registerHandler(taskType: string, handler: TaskHandler): void {
    this.handlers.set(taskType, handler);
    logger.info({ taskType }, "[TaskQueue] Handler registered");
  }

  async enqueue(params: {
    taskType: InsertTask["taskType"];
    payload: Record<string, unknown>;
    maxAttempts?: number;
    scheduledFor?: Date;
    periodic?: boolean;
  }): Promise<string> {
    const task = await TaskModel.create({
      taskType: params.taskType,
      payload: params.payload,
      maxAttempts: params.maxAttempts ?? 5,
      ...(params.scheduledFor && { scheduledFor: params.scheduledFor }),
      ...(params.periodic && { periodic: params.periodic }),
    });
    metrics.taskQueue.reportTaskEnqueued(params.taskType);
    logger.debug(
      { taskId: task.id, taskType: params.taskType },
      "[TaskQueue] Task enqueued",
    );
    return task.id;
  }

  async seedPeriodicTasks(): Promise<void> {
    for (const def of PERIODIC_TASK_DEFINITIONS) {
      try {
        const exists = await TaskModel.hasPendingOrProcessingByType(
          def.taskType,
        );
        if (exists) {
          logger.debug(
            { taskType: def.taskType },
            "[TaskQueue] Periodic task already exists, skipping seed",
          );
          continue;
        }

        await this.enqueue({
          taskType: def.taskType,
          payload: def.payload,
          maxAttempts: 1,
          periodic: true,
        });
        logger.info(
          { taskType: def.taskType },
          "[TaskQueue] Seeded periodic task",
        );
      } catch (error) {
        // Unique constraint violation means another replica seeded it — safe to ignore
        if (isUniqueViolation(error)) {
          logger.debug(
            { taskType: def.taskType },
            "[TaskQueue] Periodic task already seeded by another replica",
          );
        } else {
          logger.error(
            {
              taskType: def.taskType,
              error: error instanceof Error ? error.message : String(error),
            },
            "[TaskQueue] Failed to seed periodic task",
          );
        }
      }
    }
  }

  startWorker(): void {
    const pollIntervalMs = config.kb.taskWorkerPollIntervalSeconds * 1000;

    this.stopping = false;
    // Sweep on the first poll of a fresh worker, then at most once per minute.
    this.lastStuckSweepAt = 0;

    this.pollIntervalId = setInterval(() => {
      this.poll().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "[TaskQueue] Poll error",
        );
      });
    }, pollIntervalMs);

    logger.info(
      {
        pollIntervalMs,
        maxConcurrent: config.kb.taskWorkerMaxConcurrent,
      },
      "[TaskQueue] Worker started",
    );
  }

  async stopWorker(): Promise<void> {
    this.stopping = true;
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }

    // Everything below shares one deadline: callers (server shutdown) only
    // budget taskWorkerShutdownTimeoutSeconds plus a small buffer before
    // force-exiting, so an unbounded pre-drain wait would let the process
    // die before the drain/release ran.
    const timeoutMs = config.kb.taskWorkerShutdownTimeoutSeconds * 1000;
    const deadline = Date.now() + timeoutMs;

    // A poll may be mid-dequeue with its task not yet tracked; wait for it so
    // the drain below sees the full in-flight set and the process cannot exit
    // before a just-dequeued task is released back to the queue.
    if (this.pollInFlight) {
      await this.raceWithDeadline(
        this.pollInFlight.catch(() => {}),
        deadline,
      );
    }

    if (this.activeTaskIds.size === 0) {
      logger.info("[TaskQueue] Worker stopped (no in-flight tasks)");
      return;
    }

    const taskIds = [...this.activeTaskIds];
    logger.info(
      { taskIds, timeoutMs },
      "[TaskQueue] Draining in-flight tasks...",
    );

    const result = await this.raceWithDeadline(this.waitForDrain(), deadline);

    if (result === "timeout") {
      const remainingIds = [...this.activeTaskIds];
      this.activeTaskIds.clear();
      logger.warn(
        { taskIds: remainingIds },
        "[TaskQueue] Drain timed out, releasing tasks back to queue",
      );
      const released = await TaskModel.releaseToQueue(remainingIds);
      logger.info(
        { released, total: remainingIds.length },
        "[TaskQueue] Released tasks back to pending",
      );
    } else {
      logger.info("[TaskQueue] All in-flight tasks drained successfully");
    }
  }

  // ===== Private methods =====

  private poll(): Promise<void> {
    // The interval fires regardless of whether the previous poll finished;
    // reusing the in-flight promise prevents overlapping polls from racing on
    // shared state and lets stopWorker await the critical section.
    if (this.pollInFlight) {
      return this.pollInFlight;
    }
    const run = this.doPoll().finally(() => {
      this.pollInFlight = null;
    });
    this.pollInFlight = run;
    return run;
  }

  private async doPoll(): Promise<void> {
    if (this.stopping) return;

    if (Date.now() - this.lastStuckSweepAt >= STUCK_SWEEP_INTERVAL_MS) {
      this.lastStuckSweepAt = Date.now();
      // Reset stuck tasks (processing for more than 1 hour)
      const swept = await TaskModel.resetStuckTasks(STUCK_TASK_TIMEOUT_MS);
      if (swept.length > 0) {
        metrics.taskQueue.reportStuckTasksReset(swept.length);
        logger.warn(
          { resetCount: swept.length },
          "[TaskQueue] Reset stuck tasks",
        );
      }
      // A stuck periodic task that went straight to dead would silently end
      // its chain — resurrect it here.
      for (const transition of swept) {
        if (transition.periodic && transition.status === "dead") {
          await this.rescheduleIfPeriodic(transition.taskType);
        }
      }
      if (this.stopping) return;
    }

    // Dequeue and process until the concurrency cap is filled
    while (
      !this.stopping &&
      this.activeTaskIds.size < config.kb.taskWorkerMaxConcurrent
    ) {
      const task = await TaskModel.dequeue();
      if (!task) return;

      // Track immediately so a concurrent stopWorker sees this task.
      this.activeTaskIds.add(task.id);

      if (this.stopping) {
        // stopWorker may have snapshotted an empty set while the dequeue
        // was in flight; hand the task back instead of processing it
        // outside the drain. Release before untracking so shutdown cannot
        // proceed past the drain while the row is still marked processing.
        await TaskModel.releaseToQueue([task.id]);
        this.untrackTask(task.id);
        return;
      }

      this.processTask(task)
        .catch((error) => {
          logger.error(
            {
              taskId: task.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "[TaskQueue] Unhandled error in processTask",
          );
        })
        .finally(() => {
          this.untrackTask(task.id);
        });
    }
  }

  private async raceWithDeadline<T>(
    promise: Promise<T>,
    deadline: number,
  ): Promise<T | "timeout"> {
    const remainingMs = Math.max(deadline - Date.now(), 0);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remainingMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private untrackTask(taskId: string): void {
    this.activeTaskIds.delete(taskId);
    if (this.activeTaskIds.size === 0 && this.drainResolve) {
      this.drainResolve();
      this.drainResolve = null;
    }
  }

  private waitForDrain(): Promise<void> {
    if (this.activeTaskIds.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainResolve = resolve;
    });
  }

  private async processTask(task: Task): Promise<void> {
    const handler = this.handlers.get(task.taskType);
    if (!handler) {
      logger.error(
        { taskType: task.taskType, taskId: task.id },
        "[TaskQueue] No handler registered for task type",
      );
      await TaskModel.fail({
        id: task.id,
        error: `No handler registered for task type: ${task.taskType}`,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
      });
      return;
    }

    metrics.taskQueue.reportActiveTaskChange(task.taskType, 1);
    const startTime = Date.now();

    try {
      await handler(task.payload as Record<string, unknown>);
      await TaskModel.complete(task.id);
      const durationSeconds = (Date.now() - startTime) / 1000;
      metrics.taskQueue.reportTaskCompleted(task.taskType, durationSeconds);
      logger.debug(
        { taskId: task.id, taskType: task.taskType },
        "[TaskQueue] Task completed",
      );
      await this.rescheduleIfPeriodic(task.taskType);
    } catch (error) {
      metrics.taskQueue.reportTaskFailed(task.taskType);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        { taskId: task.id, taskType: task.taskType, error: errorMessage },
        "[TaskQueue] Task failed",
      );

      const result = await TaskModel.fail({
        id: task.id,
        error: errorMessage,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
      });

      if (result?.status === "dead") {
        metrics.taskQueue.reportTaskDead(task.taskType);
        // Reschedule periodic tasks that are dead
        await this.rescheduleIfPeriodic(task.taskType);

        // If the task is dead and it's a batch_embedding task, complete the batch
        // so connector run coordination isn't stuck
        if (task.taskType === "batch_embedding") {
          const payload = task.payload as Record<string, unknown>;
          const connectorRunId = payload.connectorRunId as string | undefined;
          if (connectorRunId) {
            try {
              const { ConnectorRunModel } = await import("@/models");
              await ConnectorRunModel.completeBatch(connectorRunId);
            } catch (batchError) {
              logger.error(
                {
                  taskId: task.id,
                  connectorRunId,
                  error:
                    batchError instanceof Error
                      ? batchError.message
                      : String(batchError),
                },
                "[TaskQueue] Failed to complete batch for dead-lettered task",
              );
            }
          }
        }
      }
    } finally {
      metrics.taskQueue.reportActiveTaskChange(task.taskType, -1);
    }
  }

  private async rescheduleIfPeriodic(taskType: string): Promise<void> {
    const def = PERIODIC_TASK_DEFINITIONS.find((d) => d.taskType === taskType);
    if (!def) return;

    try {
      await this.enqueue({
        taskType: def.taskType,
        payload: def.payload,
        maxAttempts: 1,
        scheduledFor: new Date(Date.now() + def.intervalSeconds * 1000),
        periodic: true,
      });
      logger.debug(
        { taskType: def.taskType, intervalSeconds: def.intervalSeconds },
        "[TaskQueue] Rescheduled periodic task",
      );
    } catch (error) {
      // Unique constraint violation means another replica already rescheduled — safe to ignore
      if (isUniqueViolation(error)) {
        logger.debug(
          { taskType: def.taskType },
          "[TaskQueue] Periodic task already rescheduled by another replica",
        );
      } else {
        logger.error(
          {
            taskType: def.taskType,
            error: error instanceof Error ? error.message : String(error),
          },
          "[TaskQueue] Failed to reschedule periodic task",
        );
      }
    }
  }
}

export const taskQueueService = new TaskQueueService();

// ===== Internal helpers =====

const STUCK_SWEEP_INTERVAL_MS = 60_000;
const STUCK_TASK_TIMEOUT_MS = 60 * 60 * 1000;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code: string }).code === "23505"
  );
}
