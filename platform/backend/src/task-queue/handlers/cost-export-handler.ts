import logger from "@/logging";
import { costExportService } from "@/services/cost-export";

/**
 * Periodic driver for scheduled cost exports: queues one run per export with
 * a due period. Errors are logged, not rethrown, so the periodic chain always
 * reschedules.
 */
export async function handleCostExport(): Promise<void> {
  try {
    await costExportService.runDue();
  } catch (error) {
    logger.error({ err: error }, "Cost export tick failed");
  }
}

/** One queued run of one export (from the periodic driver or Run now). */
export async function handleCostExportRun(
  payload: Record<string, unknown>,
): Promise<void> {
  await costExportService.runQueued(payload);
}
