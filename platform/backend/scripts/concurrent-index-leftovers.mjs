import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Drop the invalid indexes that interrupted concurrent builds left behind.
 *
 * A migration that builds an index with CREATE INDEX CONCURRENTLY IF NOT EXISTS
 * (see 0609) leaves an invalid index when the build fails: a lock timeout, a
 * killed migration Job. IF NOT EXISTS would keep that index on the rerun, so
 * the migration could never finish. An invalid index is never used by queries
 * but is still updated on every write, so dropping one is always safe.
 *
 * Only indexes that a migration builds concurrently are considered. Returns the
 * names of the indexes dropped.
 */
export async function dropInvalidConcurrentIndexes(
  client,
  {
    migrationsDir,
    // PGlite tests use the non-concurrent form; migrations always drop concurrently.
    concurrently = true,
  },
) {
  const names = concurrentIndexNames(migrationsDir);
  if (names.length === 0) return [];
  const { rows } = await client.query(
    `SELECT c.relname AS name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relnamespace = 'public'::regnamespace
        AND NOT i.indisvalid
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [names],
  );
  for (const { name } of rows) {
    await client.query(
      `DROP INDEX ${concurrently ? "CONCURRENTLY " : ""}IF EXISTS "public"."${name.replaceAll('"', '""')}"`,
    );
  }
  return rows.map(({ name }) => name);
}

function concurrentIndexNames(migrationsDir) {
  const names = new Set();
  for (const file of readdirSync(migrationsDir)) {
    if (!file.endsWith(".sql")) continue;
    // Comments do not count: a migration may suggest an out-of-band
    // concurrent build that it does not run itself.
    const sql = readFileSync(path.join(migrationsDir, file), "utf8").replace(
      LINE_COMMENT,
      "",
    );
    for (const match of sql.matchAll(CONCURRENT_INDEX)) names.add(match[1]);
  }
  return [...names];
}

const LINE_COMMENT = /--[^\n]*/g;

const CONCURRENT_INDEX =
  /CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/gi;
