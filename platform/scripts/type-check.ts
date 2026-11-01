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
 * On such a machine the compilers also take turns, with every other
 * memory-heavy tool (`scripts/heavy-lane.ts`): a root `pnpm type-check` starts
 * every package's at once through turbo, and four of them sized for the whole
 * pod would hold its memory several times over. A package whose compiler does
 * not fit beside the dev stack's servers (`TYPE_CHECK_PEAK_BYTES`) has them
 * paused while it runs. Without `flock` they run at once.
 *
 * When the kernel kills the compiler for memory anyway, the shell would only
 * say "Killed". The cgroup's counters, read before and after, say it was
 * memory, and the runner prints the limit, the peak and what to change.
 */
import { constants } from "node:os";
import path from "node:path";
import {
  describeToolMemoryKill,
  detectResourceEnvelope,
  readCgroupMemory,
  typeScriptCheckers,
  typeScriptMemorySettings,
} from "../vitest.resources.ts";
import { runHeavy, TYPE_CHECK_PEAK_BYTES } from "./heavy-lane.ts";

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
const pkg = path.basename(process.cwd());
const memoryBefore = readCgroupMemory();
// Where checkers are sized, compilers and the other heavy tools take turns
// (scripts/heavy-lane.ts), and one too big to fit beside the dev stack's
// servers has them paused while it runs.
const result = runHeavy({
  command: "tsc",
  args: tscArgs,
  env,
  label: `type-check (${pkg})`,
  peakBytes: TYPE_CHECK_PEAK_BYTES[pkg],
  lane: sized !== null,
});
if (result.error) throw result.error;
// The lane exits 128 + the signal when the compiler it ran was killed by one.
const status =
  result.status ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
// Only a compiler that was itself killed: a type error while another process
// of the container was killed is still a type error.
if (status === 128 + constants.signals.SIGKILL) {
  const checkers = checkerCount(tscArgs);
  const report = describeToolMemoryKill({
    tool: "type-check",
    subject: "tsc",
    subjectKilled: true,
    before: memoryBefore,
    after: readCgroupMemory(),
    steps:
      checkers > 1
        ? [
            `Give the compiler one checker: add --checkers 1 (this run had ${checkers}). Each checker holds its own copy of the program's types.`,
          ]
        : [],
  });
  if (report) process.stderr.write(`\n${report}\n`);
}
process.exit(status);

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

/** The checkers tsc ran with: its `--checkers`, one when single-threaded, else its default of four. */
function checkerCount(tscArgs: string[]): number {
  if (tscArgs.includes("--singleThreaded")) return 1;
  for (const [index, arg] of tscArgs.entries()) {
    const value = arg.startsWith("--checkers=")
      ? arg.slice("--checkers=".length)
      : arg === "--checkers"
        ? tscArgs[index + 1]
        : undefined;
    if (value !== undefined && /^\d+$/.test(value)) return Number(value);
  }
  return 4;
}
