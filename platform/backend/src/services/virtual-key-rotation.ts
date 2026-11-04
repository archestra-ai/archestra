import logger from "@/logging";
import { AuditLogModel, VirtualApiKeyModel } from "@/models";
import { DEFAULT_VIRTUAL_API_KEY_ROTATION_GRACE_PERIOD_SECONDS } from "@/types";

/**
 * The periodic pass behind automatic virtual key rotation: replaces the value
 * of every key whose schedule is due, then removes rotated-out values whose
 * grace period has ended. Each automatic rotation is audited as a system
 * action.
 *
 * Safe to run concurrently with itself or with a manual rotation: a key is
 * rotated only if it is still due when its row is locked.
 */
export async function rotateDueVirtualKeys(): Promise<{
  rotated: number;
  purged: number;
}> {
  const now = new Date();
  let rotated = 0;
  let batch = await VirtualApiKeyModel.findDueForRotation({
    now,
    limit: BATCH_SIZE,
  });
  for (let pass = 0; pass < MAX_BATCHES && batch.length > 0; pass++) {
    for (const key of batch) {
      if (await rotateDueKey({ key, now })) rotated++;
    }
    if (batch.length < BATCH_SIZE) break;
    batch = await VirtualApiKeyModel.findDueForRotation({
      now,
      limit: BATCH_SIZE,
    });
  }

  const purged = await VirtualApiKeyModel.purgeExpiredPreviousTokens({
    now,
    limit: BATCH_SIZE * MAX_BATCHES,
  });
  if (rotated > 0 || purged > 0) {
    logger.info(
      { rotated, purged },
      "virtual key rotation: rotated due keys and removed expired values",
    );
  }
  return { rotated, purged };
}

// ===================================================================
// Internal helpers
// ===================================================================

const BATCH_SIZE = 100;
/** Bounds one run; anything left over is due again on the next tick. */
const MAX_BATCHES = 10;

async function rotateDueKey(params: {
  key: Awaited<
    ReturnType<typeof VirtualApiKeyModel.findDueForRotation>
  >[number];
  now: Date;
}): Promise<boolean> {
  const { key, now } = params;
  try {
    const before = await VirtualApiKeyModel.findByIdForAudit(
      key.id,
      key.organizationId,
    );
    const result = await VirtualApiKeyModel.rotate({
      id: key.id,
      gracePeriodSeconds:
        key.rotationGracePeriodSeconds ??
        DEFAULT_VIRTUAL_API_KEY_ROTATION_GRACE_PERIOD_SECONDS,
      onlyIfDueBy: now,
    });
    if (!result) return false;
    await AuditLogModel.create({
      organizationId: key.organizationId,
      actorId: null,
      actorType: "system",
      actorName: "Automatic key rotation",
      actorEmail: null,
      action: "virtualApiKey.rotated",
      outcome: "success",
      resourceType: "virtualApiKey",
      resourceId: key.id,
      resourceName: key.name,
      before,
      after: await VirtualApiKeyModel.findByIdForAudit(
        key.id,
        key.organizationId,
      ),
      occurredAt: new Date(),
    }).catch((error) =>
      logger.error(
        { error, virtualKeyId: key.id },
        "virtual key rotation: failed to record the audit entry",
      ),
    );
    return true;
  } catch (error) {
    // One key failing must not hold back the rest; it stays due and is
    // retried on the next run.
    logger.error(
      {
        virtualKeyId: key.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "virtual key rotation: failed to rotate a due key",
    );
    return false;
  }
}
