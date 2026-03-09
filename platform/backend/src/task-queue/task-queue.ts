import config from "@/config";
import logger from "@/logging";
import { TaskModel } from "@/models";
import type { InsertTask, Task } from "@/types/task";
import PERIODIC_TASK_DEFINITIONS from "./periodic-tasks";

type TaskHandler = (payload: Record<string, unknown>) => Promise<void>;

export class TaskQueueService {
  private handlers = new Map<string, TaskHandler>();
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private activeTasks = 0;
  private stopping = false;

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

  stopWorker(): void {
    this.stopping = true;
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    logger.info("[TaskQueue] Worker stopped");
  }

  // ===== Private methods =====

  private async poll(): Promise<void> {
    if (this.stopping) return;
    if (this.activeTasks >= config.kb.taskWorkerMaxConcurrent) return;

    // Reset stuck tasks (processing for more than 1 hour)
    const resetCount = await TaskModel.resetStuckTasks(60 * 60 * 1000);
    if (resetCount > 0) {
      logger.warn({ resetCount }, "[TaskQueue] Reset stuck tasks");
    }

    // Dequeue and process
    const task = await TaskModel.dequeue();
    if (!task) return;

    this.activeTasks++;
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
        this.activeTasks--;
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

    try {
      await handler(task.payload as Record<string, unknown>);
      await TaskModel.complete(task.id);
      logger.debug(
        { taskId: task.id, taskType: task.taskType },
        "[TaskQueue] Task completed",
      );
      await this.rescheduleIfPeriodic(task.taskType);
    } catch (error) {
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

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code: string }).code === "23505"
  );
}
