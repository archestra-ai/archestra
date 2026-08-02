import config from "@/config";
import logger from "@/logging";
import { AuditLogModel } from "@/models";
import {
  PURGEABLE_ENTITIES,
  type PurgeableEntity,
} from "@/services/soft-delete-purge";
import type { AuditableSnapshot, InsertAuditLog } from "@/types/audit-log";

/**
 * Soft-delete retention sweep: permanently deletes rows soft-deleted longer
 * ago than `config.softDeleteRetention.days`, per entity in dependency order
 * (see PURGEABLE_ENTITIES). Core, not enterprise — unlike the content
 * retention sweep this file takes its shape from.
 *
 * Disabled is a fast no-op with zero queries. The window is read at sweep
 * time, so enabling the flag purges everything already past the window on the
 * next tick, and shortening the window takes effect immediately — documented
 * behaviour, not a bug.
 *
 * Idempotent and replica-safe: every hardDelete re-checks eligibility under
 * FOR UPDATE (a restore between select and purge wins), and the task queue
 * claims with FOR UPDATE SKIP LOCKED, so concurrent sweeps cannot double-run.
 * Each purge commits atomically with its audit row (via `onPurged`), so a
 * row can never be destroyed without a trail of it having existed.
 */
export async function handleSoftDeletePurge(): Promise<void> {
  if (!config.softDeleteRetention.enabled) return;
  const retentionDays = config.softDeleteRetention.days;

  // One entity's failure never blocks the rest, matching the content
  // retention sweep's swallow-and-log posture.
  for (const entity of PURGEABLE_ENTITIES) {
    try {
      const purged = await sweepEntity(entity, retentionDays);
      if (purged > 0) {
        logger.info(
          { entity: entity.key, purged, retentionDays },
          "soft-delete purge sweep: entity complete",
        );
      }
    } catch (error) {
      logger.error(
        {
          entity: entity.key,
          error: error instanceof Error ? error.message : String(error),
        },
        "soft-delete purge sweep: entity failed",
      );
    }
  }
}

// === Internal ===

const BATCH_SIZE = 50;
const MAX_BATCHES = 200;

async function sweepEntity(
  entity: PurgeableEntity,
  retentionDays: number,
): Promise<number> {
  // Rule: never purge a row whose org cannot be resolved — destroying data
  // with no audit trail is worse than leaving it. findExpired excludes such
  // rows; surface them once per sweep so they are not silently immortal.
  if (entity.countUnresolvable) {
    const unresolvable = await entity.countUnresolvable({ retentionDays });
    if (unresolvable > 0) {
      logger.warn(
        { entity: entity.key, unresolvable, retentionDays },
        "soft-delete purge sweep: expired rows with no resolvable organization left in place",
      );
    }
  }

  let total = 0;
  // Rows scanned but not purged — still referenced, restored meanwhile, or
  // errored. Doubles as the scan offset: skipped rows keep their deleted_at,
  // so they stay the oldest prefix of every scan, while purged rows vanish
  // from it — OFFSET skipped therefore always lands on the first row this
  // sweep has not seen yet, and a wall of un-purgeable rows can never starve
  // the purgeable rows behind it. (The invariant breaks if a skip path ever
  // touches deleted_at, or the scans lose their (deleted_at, id) order.)
  let skipped = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const candidates = await entity.findExpired({
      retentionDays,
      limit: BATCH_SIZE,
      offset: skipped,
    });
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      // Per-row try/catch: one bad row cannot stall the sweep.
      try {
        // Snapshot the identity BEFORE the delete — afterwards it is gone.
        const identity = await entity.identity(candidate);
        const purged = await entity.hardDelete(candidate.id, {
          onlyIfDeletedForDays: retentionDays,
          // Audit row in the delete transaction: the purge and its trail
          // commit atomically. A failed insert rolls the delete back (caught
          // and logged below) and the next sweep retries — a purge can never
          // land unrecorded.
          onPurged: async (tx) => {
            await AuditLogModel.create(
              purgeAuditRow(entity, candidate, identity),
              tx,
            );
          },
        });
        if (purged) {
          total++;
        } else {
          // Restored meanwhile or still referenced; next sweep retries.
          skipped++;
        }
      } catch (error) {
        skipped++;
        logger.warn(
          {
            entity: entity.key,
            id: candidate.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "soft-delete purge sweep: candidate failed, skipping",
        );
      }
    }

    // A short batch means the scan is exhausted. Every full batch either
    // purged rows or advanced the offset, so the loop always progresses;
    // MAX_BATCHES stays as the backstop.
    if (candidates.length < BATCH_SIZE) break;
  }
  if (skipped > 0) {
    logger.warn(
      { entity: entity.key, skipped, retentionDays },
      "soft-delete purge sweep: expired rows left in place (still referenced, restored mid-sweep, or errored)",
    );
  }
  return total;
}

function purgeAuditRow(
  entity: PurgeableEntity,
  candidate: { id: string; organizationId: string },
  identity: AuditableSnapshot,
): InsertAuditLog {
  return {
    organizationId: candidate.organizationId,
    actorId: null,
    actorType: "system",
    actorName: null,
    actorEmail: null,
    action: entity.auditAction,
    outcome: "success",
    resourceType: entity.resourceType,
    resourceId: candidate.id,
    resourceName: typeof identity?.name === "string" ? identity.name : null,
    before: identity,
    after: null,
    httpMethod: null,
    httpPath: null,
    httpRoute: null,
    httpStatus: null,
    requestId: null,
    sourceIp: null,
    userAgent: null,
    occurredAt: new Date(),
  };
}
