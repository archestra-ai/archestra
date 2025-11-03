import { and, eq, isNull, lt, or } from "drizzle-orm";
import db, { schema } from "@/database";

export async function cleanupLimitsIfNeeded(
  organizationId: string,
): Promise<void> {
  try {
    // Get the organization's cleanup interval
    const [organization] = await db
      .select()
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, organizationId));

    if (!organization?.limitCleanupInterval) {
      // No cleanup interval set, nothing to do
      return;
    }

    // Parse the interval and calculate the cutoff time
    const interval = organization.limitCleanupInterval;
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
        return;
    }

    // Find limits that need cleanup (last_cleanup is null or older than cutoff)
    const limitsToCleanup = await db
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.entityType, "organization"),
          eq(schema.limitsTable.entityId, organizationId),
          // Either never cleaned up OR last cleanup was before cutoff
          or(
            isNull(schema.limitsTable.lastCleanup),
            lt(schema.limitsTable.lastCleanup, cutoffTime),
          ),
        ),
      );

    // Reset current usage and update last cleanup for eligible limits
    if (limitsToCleanup.length > 0) {
      for (const limit of limitsToCleanup) {
        await db
          .update(schema.limitsTable)
          .set({
            currentUsage: 0,
            lastCleanup: now,
            updatedAt: now,
          })
          .where(eq(schema.limitsTable.id, limit.id));
      }
    }
  } catch (error) {
    console.error("Error cleaning up limits:", error);
    // Don't throw - cleanup is best effort and shouldn't break the main flow
  }
}
