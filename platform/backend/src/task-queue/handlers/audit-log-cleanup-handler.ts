import config from "@/config";
import logger from "@/logging";
import { AuditLogModel } from "@/models";

export async function handleAuditLogCleanup(): Promise<void> {
  const { retentionDays } = config.auditLog;

  if (retentionDays === 0) {
    logger.info(
      { retentionDays },
      "audit-log retention sweep: disabled (retentionDays=0)",
    );
    return;
  }

  const before = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  try {
    // Single DELETE across all orgs — the index on `created_at` makes this
    // cheap, and one query is much friendlier than N round-trips per org.
    const deleted = await AuditLogModel.deleteAllOlderThan(before);
    logger.info(
      { deleted, retentionDays, before: before.toISOString() },
      "audit-log retention sweep: complete",
    );
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        retentionDays,
      },
      "audit-log retention sweep: failed",
    );
  }
}
