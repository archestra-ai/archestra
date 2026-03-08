import { Cron } from "croner";
import { createCapturingLogger } from "@/entrypoints/_shared/log-capture";
import { connectorSyncService } from "@/knowledge-base";
import logger from "@/logging";

const MAX_CONTINUATIONS = 50;

/**
 * In-process cron scheduler for connector syncs.
 * Used as a fallback when K8s is not configured (e.g., local development).
 * Runs sync jobs directly in the backend process using croner.
 */
class InProcessScheduler {
  private tasks = new Map<string, Cron>();
  private continuationCounts = new Map<string, number>();

  schedule(params: { connectorId: string; schedule: string }): void {
    this.unschedule(params.connectorId);

    const task = new Cron(params.schedule, () => {
      this.continuationCounts.delete(params.connectorId);
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
      this.continuationCounts.delete(connectorId);
      logger.info(
        { connectorId },
        "[InProcessScheduler] Unscheduled connector sync",
      );
    }
  }

  suspend(connectorId: string): void {
    const task = this.tasks.get(connectorId);
    if (task) {
      task.pause();
      logger.info(
        { connectorId },
        "[InProcessScheduler] Suspended connector sync",
      );
    }
  }

  resume(connectorId: string): void {
    const task = this.tasks.get(connectorId);
    if (task) {
      task.resume();
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
    this.continuationCounts.clear();
  }

  private runSync(connectorId: string): void {
    logger.info(
      { connectorId },
      "[InProcessScheduler] Starting scheduled sync",
    );

    const { logger: capturingLogger, getLogOutput } = createCapturingLogger();

    connectorSyncService
      .executeSync(connectorId, {
        logger: capturingLogger,
        getLogOutput,
      })
      .then((result) => {
        logger.info(
          { connectorId, runId: result.runId, status: result.status },
          "[InProcessScheduler] Scheduled sync completed",
        );

        // Auto-continue on partial result
        if (result.status === "partial") {
          const count = (this.continuationCounts.get(connectorId) ?? 0) + 1;
          if (count < MAX_CONTINUATIONS) {
            this.continuationCounts.set(connectorId, count);
            logger.info(
              { connectorId, continuationCount: count },
              "[InProcessScheduler] Scheduling continuation sync in 5s",
            );
            setTimeout(() => this.runSync(connectorId), 5000);
          } else {
            logger.warn(
              { connectorId, maxContinuations: MAX_CONTINUATIONS },
              "[InProcessScheduler] Max continuations reached, stopping",
            );
            this.continuationCounts.delete(connectorId);
          }
        } else {
          this.continuationCounts.delete(connectorId);
        }
      })
      .catch((error) => {
        logger.error(
          {
            connectorId,
            error: error instanceof Error ? error.message : String(error),
          },
          "[InProcessScheduler] Scheduled sync failed",
        );
        this.continuationCounts.delete(connectorId);
      });
  }
}

export const inProcessScheduler = new InProcessScheduler();
