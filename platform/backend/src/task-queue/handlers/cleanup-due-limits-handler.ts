import logger from "@/logging";
import { LimitModel, OrganizationModel } from "@/models";

export async function handleCleanupDueLimits(): Promise<void> {
  const organizations = await OrganizationModel.findAll();

  for (const organization of organizations) {
    const cleanupInterval = organization.limitCleanupInterval || "1h";
    const cutoffTime = getLimitCleanupCutoff(cleanupInterval);

    if (!cutoffTime) {
      logger.warn(
        {
          organizationId: organization.id,
          cleanupInterval,
        },
        "Skipping limit cleanup for unsupported interval",
      );
      continue;
    }

    const limits = await LimitModel.findLimitsNeedingCleanup(
      organization.id,
      cutoffTime,
    );

    for (const limit of limits) {
      await LimitModel.resetLimitUsage(limit.id);
    }

    logger.debug(
      {
        organizationId: organization.id,
        cleanupInterval,
        cleanedLimitCount: limits.length,
      },
      "Completed due limit cleanup",
    );
  }
}

function getLimitCleanupCutoff(interval: string): Date | null {
  const now = Date.now();

  switch (interval) {
    case "1h":
      return new Date(now - 60 * 60 * 1000);
    case "12h":
      return new Date(now - 12 * 60 * 60 * 1000);
    case "24h":
      return new Date(now - 24 * 60 * 60 * 1000);
    case "1w":
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case "1m":
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}
