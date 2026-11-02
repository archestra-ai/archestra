/**
 * The migrated, row-free PGlite database every database test file starts from
 * (see setup.ts), built once and kept on disk.
 *
 * Building it replays about 41 MB of migration SQL into an in-memory PGlite.
 * The WebAssembly memory that takes stays with the process that did it, so
 * global-setup.ts builds it in a child process (`build-pglite-snapshot.ts`)
 * rather than in Vitest's main process, which lives as long as the run. The
 * result is cached (pglite-snapshot-cache.ts), so later runs skip the build.
 */

import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { getMigrationsSql } from "./migrations-helper.js";

/**
 * Replays the migrations into a fresh in-memory PGlite, empties the tables
 * they seed and writes the gzipped data directory to `outPath`. The file
 * appears atomically, so concurrent runs never read a partial snapshot.
 */
export async function buildSnapshot(outPath: string): Promise<void> {
  const pg = new PGlite("memory://", { extensions: { vector } });
  for (const migrationSql of getMigrationsSql()) {
    await pg.exec(migrationSql);
  }
  // Migrations seed rows (e.g. a default organization). Ship an empty
  // snapshot so a freshly loaded test database needs no reset (setup.ts).
  await truncatePublicTables(pg);
  const dump = await pg.dumpDataDir("gzip");
  const bytes = Buffer.from(await dump.arrayBuffer());
  await pg.close();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const partial = `${outPath}.${process.pid}.partial`;
  try {
    fs.writeFileSync(partial, bytes);
    fs.renameSync(partial, outPath);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

// ===== Internal helpers =====

async function truncatePublicTables(pg: PGlite): Promise<void> {
  const { rows } = await pg.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename NOT LIKE 'drizzle_%'
  `);
  if (rows.length === 0) return;
  const tables = rows.map((row) => `"${row.tablename}"`).join(", ");
  await pg.exec(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}
