import config from "@/config";
import logger from "@/logging";
import { AuditLogModel, OrganizationModel } from "@/models";

export async function handleAuditLogCleanup(): Promise<void> {
  const { retentionDays } = config.auditLog;

  if (retentionDays === 0) {
    logger.info(
      { retentionDays },
      "audit-log retention sweep: disabled (retentionDays=0)",
    );
    return;
  }

  const orgIds = await OrganizationModel.findAllIds();
  const before = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;

  for (const organizationId of orgIds) {
    try {
      const deleted = await AuditLogModel.deleteOlderThan({
        organizationId,
        before,
      });
      totalDeleted += deleted;
    } catch (error) {
      logger.error(
        {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "audit-log retention sweep: failed for organization",
      );
    }
  }

  logger.info(
    {
      orgs: orgIds.length,
      deleted: totalDeleted,
      retentionDays,
    },
    "audit-log retention sweep: complete",
  );
}
