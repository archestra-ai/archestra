#!/usr/bin/env node
// Checks the backend's layer order (layers.mjs)
// against the imports that may still break it
// (.dependency-cruiser-known-violations.json). Fails on a new upward import,
// and on a listed import that no longer exists, so the list only shrinks: run
// `pnpm check:layers:update` after a slice that removes some.
//
// Usage: node scripts/check-layers.mjs [--update] [known-upward-imports.json]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const update = process.argv.includes("--update");
const knownFile = path.resolve(
  process.argv.slice(2).find((arg) => arg !== "--update") ??
    path.join(backendDir, "layers.known-upward-imports.json"),
);
const currentFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "check-layers-")),
  "violations.json",
);

const result = spawnSync(
  path.join(backendDir, "node_modules/.bin/depcruise"),
  [
    "--config",
    "layers.mjs",
    "src",
    "--output-type",
    "baseline",
    "--output-to",
    currentFile,
  ],
  { cwd: backendDir, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
);
if (result.error) throw result.error;
if (!fs.existsSync(currentFile)) {
  console.error(
    `dependency-cruiser exited ${result.status} without a result:\n${result.stderr}`,
  );
  process.exit(1);
}

const key = (v) => `${v.from} -> ${v.to} (${v.rule.name})`;
const current = new Set(JSON.parse(fs.readFileSync(currentFile, "utf8")).map(key));
fs.rmSync(path.dirname(currentFile), { recursive: true, force: true });
if (update) {
  fs.writeFileSync(knownFile, `${JSON.stringify([...current].sort(), null, 2)}\n`);
  console.log(`Listed ${current.size} upward imports in ${path.relative(backendDir, knownFile)}.`);
  process.exit(0);
}
const known = new Set(JSON.parse(fs.readFileSync(knownFile, "utf8")));

const added = [...current].filter((v) => !known.has(v)).sort();
const removed = [...known].filter((v) => !current.has(v)).sort();
if (added.length > 0) {
  console.error(
    `${added.length} new import(s) from a lower backend layer to a higher one (layers.mjs):\n` +
      added.map((v) => `  ${v}`).join("\n") +
      "\nMove the imported code down, the importing code up, or invert the dependency.",
  );
}
if (removed.length > 0) {
  console.error(
    `${removed.length} listed upward import(s) no longer exist. Shrink the list with \`pnpm check:layers:update\`:\n` +
      removed.map((v) => `  ${v}`).join("\n"),
  );
}
if (added.length > 0 || removed.length > 0) process.exit(1);
console.log(`Layer order holds (${current.size} known upward imports left to remove).`);
