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
const SNAPSHOT_CACHE_DIR = path.resolve(
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
 * this run can be reused: it is this run's name for the current inputs'
 * snapshot, and the file is there.
 */
export function publishedSnapshotIsCurrent(
  published: string | undefined,
  current: string,
): boolean {
  if (published === undefined) return false;
  const runPrefix = `${current}.${process.pid}-`;
  return (
    published.startsWith(runPrefix) &&
    /^\d+\.inuse$/.test(published.slice(runPrefix.length)) &&
    fs.existsSync(published)
  );
}

/**
 * Marks a cached snapshot as used now, so pruning keeps the snapshots runs
 * actually use rather than the ones built last, and hard-links it to this
 * run's own name. The workers read that name, so another run pruning the
 * cache can remove the cached name without the file going away under them.
 * Returns the run's path, or null when the snapshot is not cached.
 */
export function claimSnapshot(snapshot: string): string | null {
  const now = new Date();
  const runPath = runSnapshotPath(snapshot, now.getTime());
  try {
    fs.utimesSync(snapshot, now, now);
    fs.rmSync(runPath, { force: true });
    try {
      fs.linkSync(snapshot, runPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw error;
      // A file system without hard links: a private copy is as safe.
      fs.copyFileSync(snapshot, runPath);
    }
    return runPath;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Removes all but the `keep` most recently used snapshots, builds that died
 * before finishing, and the run names (claimSnapshot) of runs that died
 * before their teardown. A snapshot used or written within the last hour
 * stays either way, and so does one another run uses while this one prunes.
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
  const entries: CacheEntry[] = [];
  for (const name of names) {
    const kind = cacheEntryKind(name);
    if (!kind) continue;
    const file = path.join(directory, name);
    const mtimeMs = modifiedAt(file);
    // Undefined: another run renamed or removed it since the listing.
    if (mtimeMs !== undefined) entries.push({ file, mtimeMs, kind });
  }
  const unusedFor = (entry: CacheEntry, ms: number) => now - entry.mtimeMs > ms;
  // A run name is a hard link: its mtime is the snapshot's, which every later
  // claim refreshes, so its age is the claim time in its name.
  const claimedFor = (entry: CacheEntry, ms: number) =>
    now - (claimedAt(entry.file) ?? entry.mtimeMs) > ms;
  const snapshots = entries
    .filter((entry) => entry.kind === "snapshot")
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const removable = [
    ...snapshots
      .slice(keep)
      .filter((entry) => unusedFor(entry, IN_USE_WINDOW_MS)),
    ...entries.filter(
      (entry) => entry.kind === "partial" && unusedFor(entry, IN_USE_WINDOW_MS),
    ),
    ...entries.filter(
      (entry) => entry.kind === "run" && claimedFor(entry, RUN_NAME_MAX_AGE_MS),
    ),
  ];
  for (const entry of removable) {
    // Another run may have used it since the listing: then it stays. A run
    // that uses it between this check and the removal still reads its own
    // name for it; only the next run misses the cache. (A run name's mtime
    // moves with every claim of its snapshot and says nothing about its run.)
    if (entry.kind !== "run" && modifiedAt(entry.file) !== entry.mtimeMs) {
      continue;
    }
    fs.rmSync(entry.file, { force: true });
  }
}

// ===== Internal helpers =====

const IN_USE_WINDOW_MS = 60 * 60 * 1000;

/**
 * This run's own name for a cached snapshot (see claimSnapshot): the path its
 * global setup publishes to the workers. It records when the run claimed it.
 */
function runSnapshotPath(snapshot: string, claimedAtMs: number): string {
  return `${snapshot}.${process.pid}-${claimedAtMs}.inuse`;
}

/** When a run claimed the snapshot behind a run name, from the name. */
function claimedAt(runName: string): number | undefined {
  const match = /\.\d+-(\d+)\.inuse$/.exec(runName);
  return match ? Number(match[1]) : undefined;
}

/** No test run takes a day: a run name this old outlived its run. */
const RUN_NAME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type CacheEntry = {
  file: string;
  mtimeMs: number;
  kind: "snapshot" | "partial" | "run";
};

function cacheEntryKind(name: string): CacheEntry["kind"] | null {
  if (name.endsWith(".tar.gz")) return "snapshot";
  if (name.endsWith(".partial")) return "partial";
  if (name.endsWith(".inuse")) return "run";
  return null;
}

function modifiedAt(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

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
