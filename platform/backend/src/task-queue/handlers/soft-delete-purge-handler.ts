import config from "@/config";
import logger from "@/logging";
import { DELETED_ITEM_ENTITY_TYPES, DeletedItemModel } from "@/models";
import OrganizationModel from "@/models/organization";
import { purgeDeletedItem } from "@/services/soft-delete-purge";

/**
 * Daily retention sweep: permanently deletes soft-deleted entities that have sat
 * in Deleted Items longer than their organization's retention window.
 *
 * Unlike the audit-log sweep — one global DELETE driven by an environment
 * variable — the window here is per-organization, so this iterates organizations
 * and applies each one's own policy. Work is capped per run and picks the oldest
 * deletions first, so a large backlog (every row already past the window the
 * first time this ships) drains across several days instead of one spike.
 *
 * Errors are contained at the organization level: one organization whose storage
 * backend is unhealthy must not stop the others from being swept.
 */
export async function handleSoftDeletePurge(): Promise<void> {
  if (!config.softDeletePurge.enabled) {
    logger.info(
      "soft-delete retention sweep: disabled (ARCHESTRA_SOFT_DELETE_PURGE_ENABLED=false)",
    );
    return;
  }

  const policies = await OrganizationModel.listSoftDeleteRetentionPolicies();
  const budget = { remaining: config.softDeletePurge.maxPerRun };
  const totals = { purged: 0, skipped: 0, deferred: 0 };

  for (const policy of policies) {
    if (budget.remaining <= 0) break;
    if (!policy.autoPurgeEnabled) continue;

    try {
      const result = await sweepOrganization({ policy, budget });
      totals.purged += result.purged;
      totals.skipped += result.skipped;
      totals.deferred += result.deferred;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          organizationId: policy.organizationId,
        },
        "soft-delete retention sweep: organization failed",
      );
    }
  }

  logger.info(
    {
      ...totals,
      organizations: policies.length,
      capReached: budget.remaining <= 0,
      maxPerRun: config.softDeletePurge.maxPerRun,
    },
    budget.remaining <= 0
      ? "soft-delete retention sweep: complete (per-run cap reached, remainder resumes next run)"
      : "soft-delete retention sweep: complete",
  );
}

// ===== Internal helpers =====

async function sweepOrganization(params: {
  policy: {
    organizationId: string;
    retentionDays: number;
    autoPurgeEnabled: boolean;
  };
  budget: { remaining: number };
}): Promise<{ purged: number; skipped: number; deferred: number }> {
  const { policy, budget } = params;
  const before = new Date(
    Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000,
  );
  const tally = { purged: 0, skipped: 0, deferred: 0 };

  for (const entityType of DELETED_ITEM_ENTITY_TYPES) {
    if (budget.remaining <= 0) break;

    const ids = await DeletedItemModel.listPurgeableBefore({
      organizationId: policy.organizationId,
      entityType,
      before,
      limit: budget.remaining,
    });

    for (const id of ids) {
      if (budget.remaining <= 0) break;

      // Re-read rather than trusting the id list: the row may have been restored
      // in the meantime, and `findOne` only returns still-deleted rows. It also
      // supplies the name the audit record needs before the row disappears.
      const item = await DeletedItemModel.findOne({
        entityType,
        id,
        organizationId: policy.organizationId,
      });
      if (!item) {
        tally.skipped++;
        continue;
      }

      const outcome = await purgeDeletedItem({
        item,
        organizationId: policy.organizationId,
        actor: { type: "system" },
      });

      // Only a real purge spends budget: a skip did no work, and a deferral
      // stopped precisely because it would have done too much.
      if (outcome.status === "purged") {
        tally.purged++;
        budget.remaining--;
      } else if (outcome.status === "deferred") {
        tally.deferred++;
      } else {
        tally.skipped++;
      }
    }
  }

  return tally;
}
