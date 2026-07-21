import { sql } from "drizzle-orm";
import db from "@/database";
import logger from "@/logging";

/**
 * Drop the legacy pg_trgm GIN indexes over interactions' request/response
 * payloads on deployments that created them before migration 0116 stopped
 * doing so. The free-text search they served no longer exists (the LLM logs
 * UI filters by dropdowns + exact session id), while every hot-path
 * interactions insert paid GIN maintenance over a multi-hundred-KB payload.
 *
 * This runs from worker startup rather than a Drizzle migration because
 * migrations execute inside a transaction, where only the blocking,
 * non-concurrent DROP INDEX is possible — an ACCESS EXCLUSIVE lock on the LLM
 * proxy's hottest table (see the archestra-dev-interactions-migrations rules).
 * DROP INDEX CONCURRENTLY must run outside a transaction, which is exactly
 * what a standalone autocommit statement gives us.
 *
 * Idempotent and race-tolerant: IF EXISTS makes reruns no-ops, and a failure
 * (e.g. two workers racing, or a lock wait aborted) is logged and retried on
 * the next boot.
 */
export async function dropLegacyPayloadTrgmIndexes(
  options: {
    /**
     * Tests set this to false: PGlite's single-backend WASM build rejects
     * DROP INDEX CONCURRENTLY ("tuple concurrently updated"). Production
     * callers always use the concurrent, non-write-blocking form.
     */
    concurrently?: boolean;
  } = {},
): Promise<void> {
  const concurrently = options.concurrently ?? true;
  for (const indexName of LEGACY_PAYLOAD_TRGM_INDEXES) {
    try {
      const existing = await db.execute(
        sql`select to_regclass(${indexName}) as index_oid`,
      );
      if (!existing.rows[0]?.index_oid) {
        continue;
      }

      logger.info({ indexName }, "Dropping legacy payload trgm index");
      await db.execute(
        sql.raw(
          `DROP INDEX ${concurrently ? "CONCURRENTLY " : ""}IF EXISTS "${indexName}"`,
        ),
      );
      logger.info({ indexName }, "Dropped legacy payload trgm index");
    } catch (error) {
      // Non-fatal: the index keeps working (it is just dead weight), and the
      // next worker boot retries.
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          indexName,
        },
        "Failed to drop legacy payload trgm index; will retry on next boot",
      );
    }
  }
}

// ============================================================
// Internal implementation
// ============================================================

const LEGACY_PAYLOAD_TRGM_INDEXES = [
  "interactions_request_trgm_idx",
  "interactions_response_trgm_idx",
];
