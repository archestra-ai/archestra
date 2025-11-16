import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { LimitModel } from "@/models";

export async function cleanupLimitsIfNeeded(
  organizationId: string,
): Promise<void> {
  try {
    logger.info(
      `[LimitsCleanup] Starting cleanup check for organization: ${organizationId}`,
    );

    // Get the organization's cleanup interval
    const [organization] = await db
      .select()
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, organizationId));

    // Use default cleanup interval if not set
    const cleanupInterval = organization?.limitCleanupInterval || "1h";

    if (!organization) {
      logger.warn(
        `[LimitsCleanup] Organization not found: ${organizationId}, using default interval: ${cleanupInterval}`,
      );
    } else if (!organization.limitCleanupInterval) {
      logger.info(
        `[LimitsCleanup] No cleanup interval set for organization: ${organizationId}, using default: ${cleanupInterval}`,
      );
    } else {
      logger.info(
        `[LimitsCleanup] Using cleanup interval: ${cleanupInterval} for organization: ${organizationId}`,
      );
    }

    // Parse the interval and calculate the cutoff time
    const interval = cleanupInterval;
    const now = new Date();
    let cutoffTime: Date;

    switch (interval) {
      case "1h":
        cutoffTime = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case "12h":
        cutoffTime = new Date(now.getTime() - 12 * 60 * 60 * 1000);
        break;
      case "24h":
        cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case "1w":
        cutoffTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "1m":
        cutoffTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        logger.warn(
          `[LimitsCleanup] Unknown cleanup interval: ${interval}, skipping cleanup`,
        );
        return;
    }

    logger.info(
      `[LimitsCleanup] Calculated cutoff time: ${cutoffTime.toISOString()} (interval: ${interval})`,
    );

    // Find limits that need cleanup (last_cleanup is null or older than cutoff)
    const limitsToCleanup = await LimitModel.findLimitsNeedingCleanup(
      organizationId,
      cutoffTime,
    );

    logger.info(
      `[LimitsCleanup] Found ${limitsToCleanup.length} limits that need cleanup for organization: ${organizationId}`,
    );

    if (limitsToCleanup.length > 0) {
      logger.info(
        `[LimitsCleanup] Limits to cleanup: ${limitsToCleanup.map((l) => `${l.id}(${l.limitType}:${l.lastCleanup ? l.lastCleanup.toISOString() : "never"})`).join(", ")}`,
      );
    }

    // Reset current usage and update last cleanup for eligible limits
    if (limitsToCleanup.length > 0) {
      for (const limit of limitsToCleanup) {
        logger.info(
          `[LimitsCleanup] Cleaning up limit ${limit.id}: ${limit.limitType}, current usage: in=${limit.currentUsageTokensIn}, out=${limit.currentUsageTokensOut}, lastCleanup=${limit.lastCleanup ? limit.lastCleanup.toISOString() : "never"}`,
        );

        await LimitModel.resetLimitUsage(limit.id);

        logger.info(
          `[LimitsCleanup] Successfully cleaned up limit ${limit.id}, reset usage to 0 and set lastCleanup to ${now.toISOString()}`,
        );
      }

      logger.info(
        `[LimitsCleanup] Completed cleanup of ${limitsToCleanup.length} limits for organization: ${organizationId}`,
      );
    } else {
      logger.info(
        `[LimitsCleanup] No limits need cleanup for organization: ${organizationId}`,
      );
    }
  } catch (error) {
    logger.error(
      `[LimitsCleanup] Error cleaning up limits for organization ${organizationId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("Error cleaning up limits:", error);
    // Don't throw - cleanup is best effort and shouldn't break the main flow
  }
}
