import logger from "@/logging";
import { interactionSessionPreviewBackfill } from "@/services/interaction-session-preview-backfill";

/**
 * Periodic driver for the interaction session-preview backfill. Bounded per
 * run; the next tick continues where this one stopped. Errors are logged, not
 * rethrown, so the periodic chain always reschedules.
 */
export async function handleInteractionSessionPreviewBackfill(): Promise<void> {
  try {
    const result = await interactionSessionPreviewBackfill.run();
    if (result.filled > 0 || result.failed > 0) {
      logger.info(result, "Interaction session preview backfill tick");
    }
  } catch (error) {
    logger.error(
      { err: error },
      "Interaction session preview backfill tick failed",
    );
  }
}
