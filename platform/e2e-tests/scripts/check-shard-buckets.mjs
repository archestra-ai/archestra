#!/usr/bin/env node
// Validates shard-buckets.json against the spec files on disk.
//
// The buckets drive duration-balanced CI sharding (see ../shard-buckets.ts).
// Drift is SAFE by construction — a spec in neither bucket runs on BOTH shards
// (covered, just wasteful), never skipped — but we still fail here so the
// buckets get rebalanced instead of silently unbalancing the shards.
//
// Fails on: a spec on disk in neither bucket (unbalanced/double-run), a spec in
// both buckets (would be ignored by both -> SKIPPED), or a bucket entry with no
// file on disk (stale).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const testsDir = join(here, "..", "tests");
const bucketsPath = join(here, "..", "shard-buckets.json");

function listSpecs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSpecs(full));
    else if (entry.endsWith(".spec.ts")) out.push(relative(testsDir, full));
  }
  return out;
}

const buckets = JSON.parse(readFileSync(bucketsPath, "utf8"));
const b1 = new Set(buckets["1"] ?? []);
const b2 = new Set(buckets["2"] ?? []);
const onDisk = new Set(listSpecs(testsDir));

const inBoth = [...b1].filter((f) => b2.has(f));
const uncovered = [...onDisk].filter((f) => !b1.has(f) && !b2.has(f));
const stale = [...new Set([...b1, ...b2])].filter((f) => !onDisk.has(f));

const problems = [];
if (inBoth.length) problems.push(`In BOTH buckets (would be SKIPPED): ${inBoth.join(", ")}`);
if (uncovered.length) problems.push(`On disk but in NEITHER bucket (add to a bucket): ${uncovered.join(", ")}`);
if (stale.length) problems.push(`In a bucket but not on disk (remove): ${stale.join(", ")}`);

if (problems.length) {
  console.error("shard-buckets.json is out of sync with tests/:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log(`shard-buckets.json OK: ${b1.size} + ${b2.size} = ${onDisk.size} spec files, balanced across 2 shards.`);
