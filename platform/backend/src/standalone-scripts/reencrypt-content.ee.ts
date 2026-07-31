// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Operator-run escape hatch for the content-encryption backfill/rotation
 * sweep. The same sweep runs automatically as a periodic background task;
 * this script simply drives it to completion in one sitting (initial
 * enablement of ARCHESTRA_CONTENT_ENCRYPTION_SECRET, or a rotation with
 * ..._SECRET_PREVIOUS set). Idempotent — safe to run concurrently with the
 * background task; overlapping runs are merely redundant.
 *
 * Unlike the background task, an explicit run is always a FULL re-verify:
 * a sweep already marked completed is restarted from the beginning, so rows
 * written in plaintext by not-yet-restarted replicas during the enablement
 * rollout are picked up (already-encrypted rows are cheap skips).
 *
 * Run (dev, from platform/backend):
 *   pnpm db:reencrypt-content
 * Run (prod image, from /app/backend):
 *   node dist/standalone-scripts/reencrypt-content.mjs
 */
import { runContentEncryptionBackfill } from "@/content-encryption/backfill.ee";
import { verifyContentEncryptionKey } from "@/content-encryption/guard.ee";
import { initializeDatabase } from "@/database";
import logger from "@/logging";

async function main(): Promise<void> {
  await initializeDatabase();
  await verifyContentEncryptionKey();

  let totalRewritten = 0;
  let firstRun = true;
  for (;;) {
    const result = await runContentEncryptionBackfill({
      maxBatchesPerRun: 50,
      // Only the first iteration restarts a completed sweep (an explicit
      // operator run is a full re-verify); later iterations must observe the
      // completion they themselves produce, or this loop would never end.
      restartIfCompleted: firstRun,
    });
    firstRun = false;
    totalRewritten += result.rowsRewritten;
    logger.info(
      { status: result.status, totalRewritten },
      "reencrypt-content progress",
    );
    if (result.status !== "in_progress") {
      if (result.status === "deferred") {
        logger.error(
          "sweep deferred: drop messages_content_trgm_idx first (a worker " +
            "boot with encryption enabled does this automatically)",
        );
        process.exit(1);
      }
      break;
    }
  }
  process.exit(0);
}

main().catch((error) => {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    "reencrypt-content failed",
  );
  process.exit(1);
});
