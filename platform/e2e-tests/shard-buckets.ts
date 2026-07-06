import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Duration-balanced sharding for the CI e2e suite.
 *
 * Playwright's built-in `--shard=N/2` splits the test list by count/order, not
 * by duration, which left shard 1 (which happened to get `chat.spec.ts`, the
 * ~118s outlier) ~50s heavier than shard 2 every run. Instead we assign whole
 * spec files to shards by their recorded duration (see `shard-buckets.json`,
 * regenerated from a green run) and drive the split from the config so the
 * matching is exact — a CLI file filter like `agents.spec.ts` is a regex that
 * also matches `built-in-agents.spec.ts`, which would silently mis-shard tests.
 *
 * Mechanism: each shard sets a top-level `testIgnore` for the OTHER shard's
 * files. Setup projects (`auth.*.setup.ts`) are in neither bucket, so they are
 * never ignored and run on both shards as dependencies. Drift is safe by
 * construction: a new spec file in neither bucket is ignored by neither shard,
 * so it runs on BOTH (covered, wasteful) rather than being skipped. The
 * `check:shard-buckets` script flags that drift so the buckets get rebalanced.
 */

type Buckets = { "1": string[]; "2": string[] };

// Playwright transpiles this config to CommonJS, so __dirname resolves to this
// file's directory regardless of the process cwd.
const shardBuckets = JSON.parse(
  readFileSync(join(__dirname, "shard-buckets.json"), "utf8"),
) as Buckets & { _comment?: string };

/** Anchor a `tests/`-relative spec path to a collision-free full-path RegExp. */
function specFileRegex(relPath: string): RegExp {
  const escaped = relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (^|/) requires a path-segment boundary before the name, so
  // "agents.spec.ts" does not match ".../built-in-agents.spec.ts".
  return new RegExp(`(^|/)${escaped}$`);
}

/**
 * `testIgnore` entries for the shard named by the `E2E_SHARD` env var (1 or 2):
 * the other shard's spec files. Returns [] when unset (full, unsharded run).
 */
function shardTestIgnore(): RegExp[] {
  const shard = process.env.E2E_SHARD;
  if (shard !== "1" && shard !== "2") {
    return [];
  }
  const other = shard === "1" ? "2" : "1";
  return shardBuckets[other].map(specFileRegex);
}

type TestIgnore = RegExp | string | Array<RegExp | string>;

/**
 * Merge the current shard's `testIgnore` into every project. A top-level
 * `testIgnore` does NOT work here: a project's own `testIgnore` (e.g. the
 * browser projects' `browserTestIgnore`) overrides the global one, so the shard
 * split would silently not apply to those projects. Applying per-project is
 * uniform-safe because the ignore patterns only match `*.spec.ts`, never the
 * setup projects' `*.setup.ts` files, so setup still runs on both shards.
 * A no-op when E2E_SHARD is unset.
 */
export function withShardIgnore<T extends { testIgnore?: TestIgnore }>(
  projects: T[],
): T[] {
  const ignore = shardTestIgnore();
  if (ignore.length === 0) {
    return projects;
  }
  const asArray = (v: TestIgnore | undefined): Array<RegExp | string> =>
    v == null ? [] : Array.isArray(v) ? v : [v];
  return projects.map((project) => ({
    ...project,
    testIgnore: [...asArray(project.testIgnore), ...ignore],
  }));
}
