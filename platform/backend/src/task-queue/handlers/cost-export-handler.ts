import logger from "@/logging";
import { costExportService } from "@/services/cost-export";

/**
 * Periodic driver for scheduled cost exports. Errors are logged, not
 * rethrown, so the periodic chain always reschedules; each export records its
 * own failure and retries its due periods on the next tick.
 */
export async function handleCostExport(): Promise<void> {
  try {
    await costExportService.runDue();
  } catch (error) {
    logger.error({ err: error }, "Cost export tick failed");
  }
}
