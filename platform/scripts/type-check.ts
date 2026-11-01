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
 * Below 16 GiB the compiler also runs without its incremental build state,
 * which holds about 0.45 GB more at the backend's first run, and with Go's
 * soft memory limit set (`typeScriptGoMemoryLimit`), so it collects garbage
 * before it takes the pod. Together they take the backend's peak at one
 * checker on 2 CPUs from 6.2 GiB to 5.3 GiB. An explicit `--incremental` or
 * a `GOMEMLIMIT` in the environment wins.
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
  typeScriptGoMemoryLimit,
} from "../vitest.resources.ts";

const args = process.argv.slice(2);
const envelope = detectResourceEnvelope();
const sized = typeScriptCheckers(envelope);
const goMemoryLimit = typeScriptGoMemoryLimit(envelope);
const tscArgs = [...args];
if (sized !== null && !chosen("--checkers", "--singleThreaded")) {
  tscArgs.push("--checkers", String(sized));
}
if (goMemoryLimit !== null && !chosen("--incremental", "-i")) {
  tscArgs.push("--incremental", "false");
}
const env =
  goMemoryLimit !== null && !process.env.GOMEMLIMIT
    ? { ...process.env, GOMEMLIMIT: String(goMemoryLimit) }
    : process.env;
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
  env,
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

// ===== Internal helpers =====

/** Whether the caller passed one of these options, bare or as `--name=value`. */
function chosen(...names: string[]): boolean {
  return args.some((arg) =>
    names.some((name) => arg === name || arg.startsWith(`${name}=`)),
  );
}

function hasFlock(): boolean {
  if (process.platform !== "linux") return false;
  return spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
}
