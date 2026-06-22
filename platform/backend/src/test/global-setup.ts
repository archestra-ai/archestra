/**
 * Vitest globalSetup: build the migrated test schema ONCE, snapshot it, reuse everywhere.
 *
 * Previously every test file's `beforeAll` (see setup.ts) replayed all ~270 Drizzle
 * migration files (~41 MB of SQL) into a fresh in-memory PGlite instance. Across 400+
 * test files that is ~100k migration executions per suite and the dominant cost of a run.
 *
 * Instead we replay the migrations a single time here (in the main process, before any
 * worker starts), `dumpDataDir()` the fully-migrated database to a temp file, and hand the
 * path to workers via an env var. Each test file then loads that snapshot with
 * `new PGlite({ loadDataDir })` — a flat cost that does not grow as migrations accumulate.
 *
 * `isolate: true` means module-level state does not survive across files, so the snapshot
 * MUST live out-of-band (a temp file), not in a module variable.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { getMigrationsSql, SNAPSHOT_PATH_ENV } from "./migrations-helper.js";

export default async function setup() {
  const pg = new PGlite("memory://", { extensions: { vector } });

  for (const migrationSql of getMigrationsSql()) {
    await pg.exec(migrationSql);
  }

  const dump = await pg.dumpDataDir("gzip");
  const bytes = Buffer.from(await dump.arrayBuffer());
  await pg.close();

  const snapshotPath = path.join(
    os.tmpdir(),
    `archestra-pglite-snapshot-${process.pid}.tar.gz`,
  );
  fs.writeFileSync(snapshotPath, bytes);
  process.env[SNAPSHOT_PATH_ENV] = snapshotPath;

  // Teardown: remove the temp snapshot once the whole suite finishes.
  return () => {
    fs.rmSync(snapshotPath, { force: true });
  };
}
