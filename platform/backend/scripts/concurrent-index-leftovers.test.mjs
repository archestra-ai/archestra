import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { dropInvalidConcurrentIndexes } from "./concurrent-index-leftovers.mjs";

// PGlite cannot run concurrent DDL, so these tests take the plain DROP. An
// interrupted concurrent build is modelled by marking the index invalid in the
// catalog, which is the state PostgreSQL leaves behind.
test("drops only the invalid leftovers of indexes that migrations build concurrently", async (t) => {
  const migrationsDir = await mkdtemp(
    path.join(os.tmpdir(), "archestra-concurrent-index-"),
  );
  t.after(() => rm(migrationsDir, { recursive: true, force: true }));
  await writeFile(
    path.join(migrationsDir, "0001_indexes.sql"),
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "interrupted_idx" ON "items" ("a");--> statement-breakpoint\n' +
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "built_idx" ON "items" ("b");',
  );
  await writeFile(
    path.join(migrationsDir, "0002_other.sql"),
    '-- Build it out of band first:\n--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "plain_idx" ON "items" ("c");\n' +
      'CREATE INDEX "plain_idx" ON "items" ("c");',
  );

  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE items (a int, b int, c int);
    CREATE INDEX interrupted_idx ON items (a);
    CREATE INDEX built_idx ON items (b);
    CREATE INDEX plain_idx ON items (c);
  `);
  await database.query(
    "UPDATE pg_index SET indisvalid = false WHERE indexrelid IN ('interrupted_idx'::regclass, 'plain_idx'::regclass)",
  );

  assert.deepEqual(
    await dropInvalidConcurrentIndexes(database, {
      migrationsDir,
      concurrently: false,
    }),
    ["interrupted_idx"],
  );
  const remaining = await database.query(
    "SELECT relname FROM pg_class WHERE relkind = 'i' AND relname LIKE '%_idx' ORDER BY relname",
  );
  // The valid concurrent build stays, and an invalid index that no migration
  // builds concurrently is not this routine's to remove.
  assert.deepEqual(
    remaining.rows.map(({ relname }) => relname),
    ["built_idx", "plain_idx"],
  );
  assert.deepEqual(
    await dropInvalidConcurrentIndexes(database, {
      migrationsDir,
      concurrently: false,
    }),
    [],
  );
});

test("finds nothing to drop before the tables exist", async (t) => {
  const migrationsDir = await mkdtemp(
    path.join(os.tmpdir(), "archestra-concurrent-index-"),
  );
  t.after(() => rm(migrationsDir, { recursive: true, force: true }));
  await writeFile(
    path.join(migrationsDir, "0001_indexes.sql"),
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "interrupted_idx" ON "items" ("a");',
  );
  const database = new PGlite();
  t.after(() => database.close());

  assert.deepEqual(
    await dropInvalidConcurrentIndexes(database, {
      migrationsDir,
      concurrently: false,
    }),
    [],
  );
});
