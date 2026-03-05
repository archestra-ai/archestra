import { schedule as cronSchedule, type ScheduledTask } from "node-cron";
import { connectorSyncService } from "@/knowledge-base/connector-sync";
import logger from "@/logging";

/**
 * In-process cron scheduler for connector syncs.
 * Used as a fallback when K8s is not configured (e.g., local development).
 * Runs sync jobs directly in the backend process using node-cron.
 */
class InProcessScheduler {
  private tasks = new Map<string, ScheduledTask>();

  schedule(params: { connectorId: string; schedule: string }): void {
    this.unschedule(params.connectorId);

    const task = cronSchedule(params.schedule, () => {
      this.runSync(params.connectorId);
    });

    this.tasks.set(params.connectorId, task);
    logger.info(
      { connectorId: params.connectorId, schedule: params.schedule },
      "[InProcessScheduler] Scheduled connector sync",
    );
  }

  unschedule(connectorId: string): void {
    const existing = this.tasks.get(connectorId);
    if (existing) {
      existing.stop();
      this.tasks.delete(connectorId);
      logger.info(
        { connectorId },
        "[InProcessScheduler] Unscheduled connector sync",
      );
    }
  }

  suspend(connectorId: string): void {
    const task = this.tasks.get(connectorId);
    if (task) {
      task.stop();
      logger.info(
        { connectorId },
        "[InProcessScheduler] Suspended connector sync",
      );
    }
  }

  resume(connectorId: string): void {
    const task = this.tasks.get(connectorId);
    if (task) {
      task.start();
      logger.info(
        { connectorId },
        "[InProcessScheduler] Resumed connector sync",
      );
    }
  }

  isScheduled(connectorId: string): boolean {
    return this.tasks.has(connectorId);
  }

  stopAll(): void {
    for (const [connectorId, task] of this.tasks) {
      task.stop();
      logger.debug(
        { connectorId },
        "[InProcessScheduler] Stopped scheduled task",
      );
    }
    this.tasks.clear();
  }

  private runSync(connectorId: string): void {
    logger.info(
      { connectorId },
      "[InProcessScheduler] Starting scheduled sync",
    );

    connectorSyncService
      .executeSync(connectorId)
      .then((result) => {
        logger.info(
          { connectorId, runId: result.runId, status: result.status },
          "[InProcessScheduler] Scheduled sync completed",
        );
      })
      .catch((error) => {
        logger.error(
          {
            connectorId,
            error: error instanceof Error ? error.message : String(error),
          },
          "[InProcessScheduler] Scheduled sync failed",
        );
      });
  }
}

export const inProcessScheduler = new InProcessScheduler();
