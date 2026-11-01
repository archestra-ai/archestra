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
 * Below 16 GiB the compiler also runs with Go's soft memory limit set, so it
 * collects garbage before it takes the pod, and below 12 GiB without its
 * incremental build state (`typeScriptMemorySettings`). Together they take
 * the backend's peak at one checker on 2 CPUs from 5.8 to 6.2 GiB down to
 * 5.3 GiB. A `GOMEMLIMIT` in the environment wins, and so does an option that
 * sets the build state up (`--incremental`, `--tsBuildInfoFile`, `--build`).
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
  typeScriptMemorySettings,
} from "../vitest.resources.ts";

const args = process.argv.slice(2);
const envelope = detectResourceEnvelope();
const sized = typeScriptCheckers(envelope);
const memory = typeScriptMemorySettings(envelope);
const tscArgs = [...args];
if (sized !== null && !chosen("--checkers", "--singleThreaded")) {
  tscArgs.push("--checkers", String(sized));
}
if (
  memory?.incremental === false &&
  !chosen("--incremental", "-i", "--tsBuildInfoFile", "--build", "-b")
) {
  tscArgs.push("--incremental", "false");
}
const env =
  memory !== null && !process.env.GOMEMLIMIT
    ? { ...process.env, GOMEMLIMIT: String(memory.goMemoryLimitBytes) }
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

/**
 * Whether the caller passed one of these options, bare or as `--name=value`.
 * The compiler reads option names in any case (`--Incremental`).
 */
function chosen(...names: string[]): boolean {
  return args.some((arg) => {
    const option = arg.toLowerCase();
    return names.some((name) => {
      const wanted = name.toLowerCase();
      return option === wanted || option.startsWith(`${wanted}=`);
    });
  });
}

function hasFlock(): boolean {
  if (process.platform !== "linux") return false;
  return spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
}
