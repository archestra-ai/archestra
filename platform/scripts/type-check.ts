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
 * whole pod would hold its memory several times over. The turn is a kernel
 * file lock (`flock`, from util-linux on Linux), which the kernel releases when
 * the compiler exits however it exits. Without `flock` they run at once.
 */
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectResourceEnvelope,
  typeScriptCheckers,
} from "../vitest.resources.ts";

const args = process.argv.slice(2);
const chosen = args.some(
  (arg) =>
    arg === "--checkers" ||
    arg.startsWith("--checkers=") ||
    arg === "--singleThreaded",
);
const sized = typeScriptCheckers(detectResourceEnvelope());
const tscArgs =
  chosen || sized === null ? args : [...args, "--checkers", String(sized)];
const command =
  sized !== null && hasFlock()
    ? [
        "flock",
        path.join(tmpdir(), "archestra-type-check.lock"),
        "tsc",
        ...tscArgs,
      ]
    : ["tsc", ...tscArgs];
const result = spawnSync(command[0], command.slice(1), {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

// ===== Internal helpers =====

function hasFlock(): boolean {
  if (process.platform !== "linux") return false;
  return spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
}
