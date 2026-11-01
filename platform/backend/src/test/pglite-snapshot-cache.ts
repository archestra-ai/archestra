/**
 * Where the PGlite test snapshot (pglite-snapshot.ts) is cached, and how the
 * cache stays small. Separate from the builder so Vitest's main process and
 * the database-free unit tests never load PGlite.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Directory of the cached snapshots, inside the backend's node_modules cache. */
export const SNAPSHOT_CACHE_DIR = path.resolve(
  testDirectory,
  "../../node_modules/.cache/pglite-snapshot",
);

/**
 * The cache file for the current snapshot inputs: every migration file, the
 * code that turns them into a snapshot, and the PGlite version. The files are
 * hashed as they are read, not kept: this runs in Vitest's main process.
 */
export function snapshotCachePath(): string {
  const hash = createHash("sha256");
  hash.update(`pglite ${pgliteVersion()}\n`);
  for (const recipe of ["pglite-snapshot.ts", "migrations-helper.ts"]) {
    hash.update(fs.readFileSync(path.join(testDirectory, recipe)));
  }
  const migrationsDir = path.join(testDirectory, "../database/migrations");
  for (const file of fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    hash.update(`\0${file}\0`);
    hash.update(fs.readFileSync(path.join(migrationsDir, file)));
  }
  return path.join(
    SNAPSHOT_CACHE_DIR,
    `${hash.digest("hex").slice(0, 24)}.tar.gz`,
  );
}

/**
 * Whether the snapshot path another project's global setup published in
 * this run can be reused: it names the current inputs and the file is there.
 */
export function publishedSnapshotIsCurrent(
  published: string | undefined,
  current: string,
): boolean {
  return published === current && fs.existsSync(current);
}

/**
 * Marks a snapshot as used now, so pruning keeps the snapshots runs actually
 * use rather than the ones built last.
 */
export function touchSnapshot(file: string): void {
  const now = new Date();
  fs.utimesSync(file, now, now);
}

/**
 * Removes all but the `keep` most recently used snapshots, and builds that
 * died before finishing. A file used or written within the last hour stays
 * either way: another run may be reading it, or still writing it.
 */
export function pruneSnapshotCache(
  keep: number,
  directory: string = SNAPSHOT_CACHE_DIR,
  now: number = Date.now(),
): void {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  const entries: { file: string; mtimeMs: number; partial: boolean }[] = [];
  for (const name of names) {
    if (!name.endsWith(".tar.gz") && !name.endsWith(".partial")) continue;
    const file = path.join(directory, name);
    try {
      entries.push({
        file,
        mtimeMs: fs.statSync(file).mtimeMs,
        partial: name.endsWith(".partial"),
      });
    } catch {
      // Another run renamed or removed it since the listing: nothing to prune.
    }
  }
  const settled = (entry: { mtimeMs: number }) =>
    now - entry.mtimeMs > IN_USE_WINDOW_MS;
  const snapshots = entries
    .filter((entry) => !entry.partial)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const removable = [
    ...snapshots.slice(keep),
    ...entries.filter((entry) => entry.partial),
  ].filter(settled);
  for (const { file } of removable) {
    fs.rmSync(file, { force: true });
  }
}

// ===== Internal helpers =====

const IN_USE_WINDOW_MS = 60 * 60 * 1000;

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
