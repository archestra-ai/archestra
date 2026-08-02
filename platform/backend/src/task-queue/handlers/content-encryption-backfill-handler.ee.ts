// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { runContentEncryptionBackfill } from "@/content-encryption/backfill.ee";
import { isContentEncryptionEnabled } from "@/content-encryption/index.ee";
import logger from "@/logging";

/**
 * Periodic driver for the content-encryption backfill sweep. Bounded per run;
 * the next tick resumes from the persisted cursor. Errors are logged, not
 * rethrown, so the periodic chain always reschedules.
 */
export async function handleContentEncryptionBackfill(): Promise<void> {
  if (!isContentEncryptionEnabled()) return;

  try {
    const result = await runContentEncryptionBackfill({});
    if (result.status !== "completed" || result.rowsRewritten > 0) {
      logger.info(result, "content encryption backfill tick");
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "content encryption backfill tick failed",
    );
  }
}
