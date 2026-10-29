#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run once on the finished revision, immediately before requesting queue entry.
// No build, backend suite, browser, code generation, or running database needed.
const platform = fileURLToPath(new URL("../", import.meta.url));

try {
  const head = git("rev-parse", "HEAD");
  const expectedHead = process.argv[2] ?? head;
  if (process.argv.length > 3 || expectedHead !== head) {
    throw new Error(
      "Usage: pnpm preflight [exact PR head SHA matching local HEAD]",
    );
  }
  assertRevision(head);

  run("pnpm", ["exec", "turbo", "check:commit"]);
  run("pnpm", ["check:white-label"]);
  // Catch frontend/shared unit failures without the native backend or browser suites.
  run("pnpm", [
    "--filter",
    "@frontend",
    "--filter",
    "@archestra/shared",
    "exec",
    "vitest",
    "run",
  ]);

  assertRevision(head);
  console.log(
    `Preflight passed for ${head}. Run the relevant focused tests before enqueueing.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function assertRevision(head) {
  if (git("rev-parse", "HEAD") !== head) {
    throw new Error(
      "HEAD changed during preflight. Check the new revision before enqueueing.",
    );
  }
  if (git("status", "--porcelain", "--untracked-files=normal")) {
    throw new Error(
      "Preflight requires a clean checkout of the PR head. Commit your changes or use a clean worktree.",
    );
  }
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: platform, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ?? result.stderr.trim() ?? "Git failed",
    );
  }
  return result.stdout.trim();
}

function run(command, args) {
  console.log(`\nRunning ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: platform,
    stdio: "inherit",
    // Match hosted CI so local calendar-date assertions use the same timezone.
    env: { ...process.env, TZ: "UTC" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ??
        `${command} ${args.join(" ")} failed. Fix it before enqueueing.`,
    );
  }
}
