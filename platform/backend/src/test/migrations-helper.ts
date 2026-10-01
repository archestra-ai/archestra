/**
 * Shared helper for reading the Drizzle migration SQL files.
 *
 * Used by both the vitest `globalSetup` (which replays migrations ONCE to build a
 * reusable PGlite snapshot) and `setup.ts` (which falls back to replaying when no
 * snapshot is available). Keeping the read/sort logic in one place prevents the two
 * call sites from drifting apart.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Env var carrying the path to the prebuilt PGlite snapshot (set by global-setup.ts). */
export const SNAPSHOT_PATH_ENV = "ARCHESTRA_TEST_PGLITE_SNAPSHOT_PATH";

/**
 * Read all migration `.sql` files in deterministic (filename) order, followed
 * by the runtime-created cache table (see KEYV_CACHE_TABLE_SQL).
 * Cached after first read since the files do not change during a test run.
 */
export function getMigrationsSql(): string[] {
  if (cachedMigrationsSql) return cachedMigrationsSql;

  const migrationsDir = path.join(__dirname, "../database/migrations");
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  cachedMigrationsSql = [
    ...migrationFiles.map((file) =>
      fs.readFileSync(path.join(migrationsDir, file), "utf8"),
    ),
    KEYV_CACHE_TABLE_SQL,
  ];

  return cachedMigrationsSql;
}

let cachedMigrationsSql: string[] | null = null;

// The distributed cache's table is created at runtime by its PostgreSQL
// adapter, not by a migration. Tests that start the real cache against their
// in-process database (src/test/cache-manager.ts) need it in the schema, with
// the shape that adapter creates.
const KEYV_CACHE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS keyv_cache(key VARCHAR(255) PRIMARY KEY, value TEXT)";
