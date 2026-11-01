#!/usr/bin/env node
// Checks the backend's layer order (layers.mjs) against the upward imports
// that may still break it (layers.known-upward-imports.json). Fails on an
// upward import the list does not know, and on a listed one that no longer
// exists, so the list only shrinks: after a change that removes some, run
// `pnpm check:layers:update`.
//
// Usage: node scripts/check-layers.mjs [--update [--allow-new]] [--known <file>]
//   --update     rewrite the list without the imports that are gone; refuses
//                to add new ones
//   --allow-new  with --update, also add new ones (a deliberate exception)
//   --known      the list to compare with (tests)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseArguments(process.argv.slice(2));
const current = upwardImports();
const known = new Set(JSON.parse(fs.readFileSync(options.known, "utf8")));
const added = [...current].filter((entry) => !known.has(entry)).sort();
const removed = [...known].filter((entry) => !current.has(entry)).sort();

if (options.update) {
  if (added.length > 0 && !options.allowNew) {
    report(added, removed);
    console.error(
      "Not updating: the list may only shrink. Pass --allow-new to list these deliberately.",
    );
    process.exit(1);
  }
  fs.writeFileSync(
    options.known,
    `${JSON.stringify([...current].sort(), null, 2)}\n`,
  );
  console.log(
    `Listed ${current.size} upward imports (${removed.length} removed, ${added.length} added).`,
  );
  process.exit(0);
}
if (added.length > 0 || removed.length > 0) {
  report(added, removed);
  process.exit(1);
}
console.log(
  `Layer order holds (${current.size} known upward imports left to remove).`,
);

// ===== Internal helpers =====

/** Every import that breaks the layer order now, as "from -> to (rule)". */
function upwardImports() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "check-layers-"));
  const output = path.join(scratch, "violations.json");
  try {
    const result = spawnSync(
      path.join(backendDir, "node_modules/.bin/depcruise"),
      [
        "--config",
        "layers.mjs",
        "src",
        "--output-type",
        "baseline",
        "--output-to",
        output,
      ],
      {
        cwd: backendDir,
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
      },
    );
    if (result.error) throw result.error;
    if (!fs.existsSync(output)) {
      const how = result.signal
        ? `was killed by ${result.signal}`
        : `exited ${result.status}`;
      console.error(
        `dependency-cruiser ${how} without a result:\n${result.stderr}`,
      );
      process.exit(1);
    }
    return new Set(
      JSON.parse(fs.readFileSync(output, "utf8")).map(
        (violation) =>
          `${violation.from} -> ${violation.to} (${violation.rule.name})`,
      ),
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function report(added, removed) {
  if (added.length > 0) {
    console.error(
      `${added.length} new violation(s) of the backend's layer order (layers.mjs):\n${added
        .map((entry) => `  ${entry}`)
        .join(
          "\n",
        )}\nMove the imported code down, the importing code up, or invert the dependency; a file in no layer needs its directory added to one.`,
    );
  }
  if (removed.length > 0) {
    console.error(
      `${removed.length} listed upward import(s) no longer exist. Shrink the list with \`pnpm check:layers:update\`:\n${removed
        .map((entry) => `  ${entry}`)
        .join("\n")}`,
    );
  }
}

function parseArguments(args) {
  const parsed = {
    update: false,
    allowNew: false,
    known: path.join(backendDir, "layers.known-upward-imports.json"),
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--update") parsed.update = true;
    else if (arg === "--allow-new") parsed.allowNew = true;
    else if (arg === "--known") {
      if (!args[index + 1]) {
        console.error("--known needs the path of a list");
        process.exit(2);
      }
      parsed.known = path.resolve(args[++index]);
    } else {
      console.error(
        `Unknown argument: ${arg}\nUsage: node scripts/check-layers.mjs [--update [--allow-new]] [--known <file>]`,
      );
      process.exit(2);
    }
  }
  if (parsed.allowNew && !parsed.update) {
    console.error("--allow-new only applies with --update");
    process.exit(2);
  }
  return parsed;
}
