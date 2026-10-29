import logger from "@/logging";
import { modelCostBackfillService } from "@/services/model-cost-backfill";

/**
 * Works one active model cost backfill for a bounded time. Runs both from the
 * periodic check (which resumes unfinished backfills) and right after a
 * backfill is started. Errors are logged, not rethrown, so the periodic chain
 * always reschedules; a failed batch is recorded on the backfill itself.
 */
export async function handleModelCostBackfill(): Promise<void> {
  try {
    await modelCostBackfillService.runNext();
  } catch (error) {
    logger.error({ err: error }, "Model cost backfill run failed");
  }
}
