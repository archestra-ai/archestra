/**
 * `tsc --noEmit` with as many checkers as this machine's memory holds.
 *
 * The TypeScript 7 compiler runs four checkers by default, and each holds its
 * own copy of the checked types: the backend needs 9.3 GB that way and 6.0 GB
 * with one. An Agent Runtime pod of a small tier was killed for memory while
 * running it. The count comes from the memory and CPUs the process can count
 * on (`typeScriptCheckers` in vitest.resources.ts). An explicit `--checkers`
 * or `--singleThreaded` wins.
 *
 * On such a machine the compilers also take turns: a root `pnpm type-check`
 * starts every package's at once through turbo, and four of them sized for the
 * whole pod would hold its memory several times over.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectResourceEnvelope,
  typeScriptCheckers,
} from "../vitest.resources.ts";

main().then((status) => process.exit(status));

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const chosen = args.some(
    (arg) =>
      arg === "--checkers" ||
      arg.startsWith("--checkers=") ||
      arg === "--singleThreaded",
  );
  const sized = typeScriptCheckers(detectResourceEnvelope());
  const checkers = chosen ? null : sized;
  const release = sized === null ? () => {} : await takeTurn();
  const result = spawnSync(
    "tsc",
    checkers === null ? args : [...args, "--checkers", String(checkers)],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  release();
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// ===== Internal helpers =====

/**
 * Waits until no other type check holds the machine-wide turn, then holds it.
 * A turn whose holder has exited is taken over.
 */
async function takeTurn(): Promise<() => void> {
  const dir = path.join(tmpdir(), "archestra-type-check.lock");
  const owner = path.join(dir, "pid");
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(owner, String(process.pid));
      const release = () => rmSync(dir, { recursive: true, force: true });
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!holderAlive(owner)) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function holderAlive(owner: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(owner, "utf8"));
  } catch {
    // Created but not written yet: its holder is starting, unless that was
    // long ago and it died in between.
    try {
      return Date.now() - statSync(path.dirname(owner)).mtimeMs < 10_000;
    } catch {
      return false;
    }
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
