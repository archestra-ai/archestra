/**
 * Vitest globalSetup: build the migrated test schema ONCE, snapshot it, reuse everywhere.
 *
 * Previously every test file's `beforeAll` (see setup.ts) replayed all ~270 Drizzle
 * migration files (~41 MB of SQL) into a fresh in-memory PGlite instance. Across 400+
 * test files that is ~100k migration executions per suite and the dominant cost of a run.
 *
 * Instead the migrations are replayed a single time, the fully-migrated database is
 * dumped to a file, and workers get its path through an env var. Each test file then
 * loads that snapshot with `new PGlite({ loadDataDir })` — a flat cost that does not grow
 * as migrations accumulate.
 *
 * The snapshot is built by a child process and cached on disk under the hash of the
 * migrations (pglite-snapshot.ts): building it in Vitest's main process left about
 * 0.4 GiB of PGlite memory there for the whole run, and later runs reuse the file.
 *
 * `isolate: true` means module-level state does not survive across files, so the snapshot
 * MUST live out-of-band (a file), not in a module variable.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtAppsInlineBundle } from "../standalone-scripts/build-ext-apps-inline";
import { SNAPSHOT_PATH_ENV } from "./migrations-helper.js";
import { pruneSnapshotCache, snapshotCachePath } from "./pglite-snapshot.js";

export default async function setup() {
  // Database-backed projects call this setup. Vitest initializes their global
  // setups sequentially in one process, so the first project publishes the
  // path and the others reuse it.
  const existingSnapshotPath = process.env[SNAPSHOT_PATH_ENV];
  if (existingSnapshotPath && fs.existsSync(existingSnapshotPath)) return;

  // The MCP-App connector inlines this generated, gitignored bundle and the
  // connector route tests read it, so build it once if a fresh checkout (CI)
  // hasn't — `build`/`dev` generate it via tsdown otherwise.
  if (!fs.existsSync(path.resolve("src/static/ext-apps-app.global.js"))) {
    buildExtAppsInlineBundle();
  }

  const snapshotPath = snapshotCachePath();
  if (!fs.existsSync(snapshotPath)) {
    buildSnapshotInChildProcess(snapshotPath);
    pruneSnapshotCache(SNAPSHOTS_KEPT);
  }
  process.env[SNAPSHOT_PATH_ENV] = snapshotPath;

  return () => {
    delete process.env[SNAPSHOT_PATH_ENV];
  };
}

// ===== Internal helpers =====

/** Snapshots kept on disk: the current one and a few for other branches. */
const SNAPSHOTS_KEPT = 3;

function buildSnapshotInChildProcess(snapshotPath: string): void {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(testDirectory, "build-pglite-snapshot.ts");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, snapshotPath],
    // From the backend directory, where `--import tsx` resolves.
    { stdio: "inherit", cwd: path.resolve(testDirectory, "../..") },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Building the PGlite test snapshot failed (exit ${result.status ?? result.signal})`,
    );
  }
}
