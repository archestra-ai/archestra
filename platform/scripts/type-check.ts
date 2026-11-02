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
 *
 * A package whose tsconfig.json is a solution (no files of its own, only
 * project references) is checked one project at a time instead
 * (type-check-solution.ts), with the same sizing.
 */
import { existsSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import {
  describeToolMemoryKill,
  detectResourceEnvelope,
  readCgroupMemory,
  TYPE_CHECK_PEAK_BYTES,
  typeScriptCheckers,
  typeScriptMemorySettings,
} from "../vitest.resources.ts";
import { runHeavy } from "./heavy-lane.ts";
import {
  checkerCount,
  hasOption,
  solutionBuildOrder,
  typeCheckSolution,
} from "./type-check-solution.ts";

const args = process.argv.slice(2);
const envelope = detectResourceEnvelope();
const sized = typeScriptCheckers(envelope);
const memory = typeScriptMemorySettings(envelope);
const solution = checkedSolution();
if (solution) {
  process.exit(
    typeCheckSolution({
      projects: solution.projects,
      solutionDir: path.dirname(solution.config),
      // Source projects must write their declarations.
      args: argsWithout(["--noEmit"], ["--project", "-p"]),
      packageName: checkedPackage(),
      checkers: sized,
      goMemoryLimitBytes: memory?.goMemoryLimitBytes ?? null,
      lane: sized !== null,
    }),
  );
}
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
const pkg = checkedPackage();
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

/** The checked config, `--project`/`-p` or tsconfig.json, with its projects when it is a solution. */
function checkedSolution(): {
  config: string;
  projects: NonNullable<ReturnType<typeof solutionBuildOrder>>;
} | null {
  let config = "tsconfig.json";
  for (const [index, arg] of args.entries()) {
    const lower = arg.toLowerCase();
    if (lower.startsWith("--project=")) config = arg.slice("--project=".length);
    else if (lower === "--project" || lower === "-p")
      config = args[index + 1] ?? config;
  }
  config = path.resolve(config);
  if (!config.endsWith(".json")) config = path.join(config, "tsconfig.json");
  if (!existsSync(config)) return null;
  const projects = solutionBuildOrder(config);
  return projects ? { config, projects } : null;
}

/** The caller's args without these flags and these options with their values. */
function argsWithout(flags: string[], options: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const lower = args[index].toLowerCase();
    if (flags.some((flag) => lower === flag.toLowerCase())) continue;
    const option = options.find(
      (name) =>
        lower === name.toLowerCase() ||
        lower.startsWith(`${name.toLowerCase()}=`),
    );
    if (option) {
      if (!lower.includes("=")) index++;
      continue;
    }
    kept.push(args[index]);
  }
  return kept;
}

/**
 * The package this check covers: the directory of its `--project`/`-p` when
 * given (the migration linter checks its project from backend/), else the
 * working directory. It names the check and its declared peak.
 */
function checkedPackage(): string {
  for (const [index, arg] of args.entries()) {
    const lower = arg.toLowerCase();
    const value = lower.startsWith("--project=")
      ? arg.slice("--project=".length)
      : lower === "--project" || lower === "-p"
        ? args[index + 1]
        : undefined;
    if (value) {
      const project = path.resolve(value);
      return path.basename(
        project.endsWith(".json") ? path.dirname(project) : project,
      );
    }
  }
  return path.basename(process.cwd());
}

/** Whether the caller passed one of these options (`hasOption`). */
function chosen(...names: string[]): boolean {
  return hasOption(args, ...names);
}
