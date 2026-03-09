import { Cron } from "croner";
import config from "@/config";
import logger from "@/logging";
import { KnowledgeBaseConnectorModel, TaskModel } from "@/models";
import type { InsertTask, Task } from "@/types/task";

type TaskHandler = (payload: Record<string, unknown>) => Promise<void>;

export class TaskQueueService {
  private handlers = new Map<string, TaskHandler>();
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private schedulerIntervalId: ReturnType<typeof setInterval> | null = null;
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
  }): Promise<string> {
    const task = await TaskModel.create({
      taskType: params.taskType,
      payload: params.payload,
      maxAttempts: params.maxAttempts ?? 5,
    });
    logger.debug(
      { taskId: task.id, taskType: params.taskType },
      "[TaskQueue] Task enqueued",
    );
    return task.id;
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

    // Check for due connectors every 60s
    this.schedulerIntervalId = setInterval(() => {
      this.checkDueConnectors().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "[TaskQueue] Scheduler error",
        );
      });
    }, 60_000);

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
    if (this.schedulerIntervalId) {
      clearInterval(this.schedulerIntervalId);
      this.schedulerIntervalId = null;
    }
    logger.info("[TaskQueue] Worker stopped");
  }

  // ===== Private methods =====

  private async poll(): Promise<void> {
    if (this.stopping) return;
    if (this.activeTasks >= config.kb.taskWorkerMaxConcurrent) return;

    // Reset stuck tasks (processing for more than 10 minutes)
    const resetCount = await TaskModel.resetStuckTasks(10 * 60 * 1000);
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

      // If the task is dead and it's a batch_embedding task, complete the batch
      // so connector run coordination isn't stuck
      if (result?.status === "dead" && task.taskType === "batch_embedding") {
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

  private async checkDueConnectors(): Promise<void> {
    const connectors = await KnowledgeBaseConnectorModel.findAllEnabled();

    for (const connector of connectors) {
      if (!connector.schedule) continue;

      try {
        const cron = new Cron(connector.schedule);
        const nextRun = cron.nextRun(connector.lastSyncAt ?? new Date(0));

        if (nextRun && nextRun <= new Date()) {
          const exists = await TaskModel.hasPendingOrProcessing(
            "connector_sync",
            connector.id,
          );
          if (!exists) {
            await this.enqueue({
              taskType: "connector_sync",
              payload: { connectorId: connector.id },
            });
            logger.info(
              { connectorId: connector.id },
              "[TaskQueue] Enqueued scheduled connector sync",
            );
          }
        }
      } catch (error) {
        logger.warn(
          {
            connectorId: connector.id,
            schedule: connector.schedule,
            error: error instanceof Error ? error.message : String(error),
          },
          "[TaskQueue] Failed to evaluate connector schedule",
        );
      }
    }
  }
}

export const taskQueueService = new TaskQueueService();
