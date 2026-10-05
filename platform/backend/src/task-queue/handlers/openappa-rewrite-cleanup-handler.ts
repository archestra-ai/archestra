import logger from "@/logging";
import OpenAppaRewriteModel from "@/models/openappa-rewrite";

const CLEANUP_BATCH_SIZE = 500;

/**
 * One bounded sweep per tick, even when OpenAPPA is off. Tables exist after
 * migration, and live or expired rows can outlive the feature flag. The task
 * queue owns the minute schedule, the single-worker claim, and shutdown.
 */
export async function handleOpenAppaRewriteCleanup(): Promise<void> {
  try {
    const deleted = await OpenAppaRewriteModel.expireInactive({
      batchSize: CLEANUP_BATCH_SIZE,
    });
    logger.info({ deleted }, "OpenAPPA rewrite cleanup complete");
  } catch {
    logger.error("OpenAPPA rewrite cleanup failed");
  }
}
