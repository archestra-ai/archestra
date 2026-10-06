import logger from "@/logging";
import OpenAppaRewriteModel from "@/models/openappa-rewrite";

/**
 * Drain full batches within row and time budgets, even when OpenAPPA is off.
 * Tables exist after migration, so rows can outlive the feature flag. The task
 * queue owns the minute schedule, the single-worker claim, and shutdown.
 */
export async function handleOpenAppaRewriteCleanup(): Promise<void> {
  try {
    const startedAt = performance.now();
    let deleted = 0;
    do {
      const batchDeleted = await OpenAppaRewriteModel.expireInactive({
        batchSize: CLEANUP_BATCH_SIZE,
      });
      deleted += batchDeleted;
      if (batchDeleted < CLEANUP_BATCH_SIZE) break;
      // The budget is soft: finish the current batch, but start no more.
    } while (
      deleted < CLEANUP_MAX_ROWS_PER_TICK &&
      performance.now() - startedAt < CLEANUP_WORK_BUDGET_MS
    );
    logger.info({ deleted }, "OpenAPPA rewrite cleanup complete");
  } catch (error) {
    logger.error("OpenAPPA rewrite cleanup failed");
    throw error;
  }
}

const CLEANUP_BATCH_SIZE = 500;
const CLEANUP_MAX_ROWS_PER_TICK = 5_000;
const CLEANUP_WORK_BUDGET_MS = 2_000;
