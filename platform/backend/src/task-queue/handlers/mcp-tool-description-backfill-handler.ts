import { backfillMcpToolDescriptions } from "@/services/mcp-tool-description-backfill";

/**
 * Periodic driver for the per-installation tool description backfill. The
 * service logs its own outcome and never throws, so the periodic chain always
 * reschedules: an installation that could not be reached keeps serving the
 * shared description only until a later pass records its own.
 */
export async function handleMcpToolDescriptionBackfill(): Promise<void> {
  await backfillMcpToolDescriptions();
}
