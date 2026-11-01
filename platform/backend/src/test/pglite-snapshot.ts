/**
 * The migrated, row-free PGlite database every database test file starts from
 * (see setup.ts), built once and kept on disk.
 *
 * Building it replays about 41 MB of migration SQL into an in-memory PGlite.
 * The WebAssembly memory that takes stays with the process that did it, so
 * global-setup.ts builds it in a child process (`build-pglite-snapshot.ts`)
 * rather than in Vitest's main process, which lives as long as the run. The
 * result is cached under the hash of the migrations and the PGlite version,
 * so later runs skip the build.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { getMigrationsSql } from "./migrations-helper.js";

/** Directory of the cached snapshots, inside the backend's node_modules cache. */
export const SNAPSHOT_CACHE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/.cache/pglite-snapshot",
);

/** The cache file for the current migrations and PGlite version. */
export function snapshotCachePath(): string {
  const hash = createHash("sha256");
  hash.update(`pglite ${pgliteVersion()}\n`);
  for (const sql of getMigrationsSql()) {
    hash.update(sql);
    hash.update("\0");
  }
  return path.join(
    SNAPSHOT_CACHE_DIR,
    `${hash.digest("hex").slice(0, 24)}.tar.gz`,
  );
}

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
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, outPath);
}

/**
 * Removes all but the newest `keep` snapshots in the cache directory. A
 * concurrent run's `.partial` file is not a snapshot and stays.
 */
export function pruneSnapshotCache(
  keep: number,
  directory: string = SNAPSHOT_CACHE_DIR,
): void {
  let entries: { file: string; mtimeMs: number }[];
  try {
    entries = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".tar.gz"))
      .map((name) => {
        const file = path.join(directory, name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      });
  } catch {
    return;
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { file } of entries.slice(keep)) {
    fs.rmSync(file, { force: true });
  }
}

// ===== Internal helpers =====

/** The installed PGlite's version, read from the package.json above its entry. */
function pgliteVersion(): string {
  const entry = createRequire(import.meta.url).resolve("@electric-sql/pglite");
  for (let dir = path.dirname(entry); dir !== path.dirname(dir); ) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "@electric-sql/pglite" && pkg.version)
        return pkg.version;
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}

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
