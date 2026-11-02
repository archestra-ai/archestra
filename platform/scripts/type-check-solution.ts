/**
 * The type check of a package whose tsconfig.json is a solution: a file list
 * of its own that is empty, and references to the package's projects (the
 * backend's, for one). One compiler holding the whole program does not fit a
 * small Agent Runtime pod; one project at a time does.
 *
 * `scripts/type-check.ts` hands such a package here. Each project builds in a
 * process of its own (`tsc -b <project>`), references first, so the memory
 * of one is gone before the next starts and a compiler killed for memory
 * names its project. A source project writes its declarations, and the
 * projects above it read them instead of its sources. Its build state stays
 * on disk, so a second run rebuilds only what changed.
 *
 * A project that fails stops the projects that reference it, directly or not:
 * their compilers would rebuild it first and report its errors again. The
 * others still run.
 *
 * Nothing here is backend-specific: any package that turns its tsconfig.json
 * into a solution gets the same check.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import {
  describeToolMemoryKill,
  readCgroupMemory,
} from "../vitest.resources.ts";

export interface SolutionProject {
  /** Absolute path of the project's tsconfig. */
  config: string;
  /** Absolute paths of the projects it references. */
  references: string[];
}

/**
 * The projects of a solution config in build order, references first, or
 * null when the config is not a solution (it lists or includes files).
 */
export function solutionBuildOrder(
  configPath: string,
): SolutionProject[] | null {
  const solution = readConfig(path.resolve(configPath));
  const isSolution =
    Array.isArray(solution.files) &&
    solution.files.length === 0 &&
    solution.include === undefined &&
    referencesOf(solution).length > 0;
  if (!isSolution) return null;

  const order: SolutionProject[] = [];
  const done = new Set<string>();
  const visiting: string[] = [];
  const visit = (config: string) => {
    if (done.has(config)) return;
    if (visiting.includes(config)) {
      throw new Error(
        `Project references form a cycle: ${[...visiting.slice(visiting.indexOf(config)), config].map((file) => path.basename(file)).join(" -> ")}`,
      );
    }
    visiting.push(config);
    const references = referencesOf(readConfig(config));
    for (const reference of references) visit(reference);
    visiting.pop();
    done.add(config);
    order.push({ config, references });
  };
  for (const reference of referencesOf(solution)) visit(reference);
  return order;
}

export interface ProjectBuildOutcome {
  /** The first project's status that was not 0, or 0. */
  status: number;
  failed: string[];
  /** Projects not built because a project they reference failed. */
  skipped: string[];
}

/**
 * Builds the projects in order with `build`, which returns the exit status of
 * one project's build. A project referencing a failed or skipped project is
 * skipped. A build killed by SIGKILL (status 137) ends the run: the next
 * project would most likely be killed too.
 */
export function buildProjects(
  projects: SolutionProject[],
  build: (project: SolutionProject) => number,
): ProjectBuildOutcome {
  const failed: string[] = [];
  const skipped: string[] = [];
  let status = 0;
  for (const project of projects) {
    if (
      project.references.some(
        (reference) =>
          failed.includes(reference) || skipped.includes(reference),
      )
    ) {
      skipped.push(project.config);
      continue;
    }
    const projectStatus = build(project);
    if (projectStatus === 0) continue;
    failed.push(project.config);
    if (status === 0) status = projectStatus;
    if (projectStatus === KILLED_STATUS) {
      const index = projects.indexOf(project);
      skipped.push(...projects.slice(index + 1).map((later) => later.config));
      break;
    }
  }
  return { status, failed, skipped };
}

/**
 * The type check of a solution: every project with `tsc -b`, one at a time,
 * sized like the single-program check. Returns the exit status.
 */
export function typeCheckSolution(params: {
  projects: SolutionProject[];
  /** The solution's directory; projects are named relative to it. */
  solutionDir: string;
  /** The caller's compiler options, without `--project` and `--noEmit`. */
  args: string[];
  /** The checkers a compiler gets (`typeScriptCheckers`), or null for the compiler's default. */
  checkers: number | null;
  /** Whether to set Go's soft memory limit (`typeScriptMemorySettings` applies). */
  limitGoMemory: boolean;
  /** Whether compilers take turns, as the single-program check does. */
  takeTurns: boolean;
}): number {
  const { projects, solutionDir, args, checkers, limitGoMemory, takeTurns } =
    params;
  const buildArgs = [...args];
  if (checkers !== null && !hasOption(args, "--checkers", "--singleThreaded")) {
    buildArgs.push("--checkers", String(checkers));
  }
  // Independent projects built at once would hold their memory side by side.
  if (!hasOption(args, "--builders")) buildArgs.push("--builders", "1");
  // Below 16 GiB, each project's compiler collects garbage before it grows
  // past what one project needs; the projects are sized to stay near it.
  const env =
    limitGoMemory && !process.env.GOMEMLIMIT
      ? { ...process.env, GOMEMLIMIT: String(PROJECT_GO_MEMORY_LIMIT_BYTES) }
      : process.env;
  const name = (config: string) =>
    path.relative(solutionDir, config).split(path.sep).join("/");

  let killedProject: string | null = null;
  let memoryBefore = readCgroupMemory();
  const outcome = buildProjects(projects, (project) => {
    const compiler = ["tsc", "-b", project.config, ...buildArgs];
    // The same turn the single-program check takes (type-check.ts), so a
    // package's projects never build beside another package's compiler.
    const command =
      takeTurns && hasFlock()
        ? [
            "flock",
            path.join(tmpdir(), "archestra-type-check.lock"),
            ...compiler,
          ]
        : compiler;
    memoryBefore = readCgroupMemory();
    const started = Date.now();
    const result = spawnSync(command[0], command.slice(1), {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    const status =
      result.status ??
      (result.signal ? 128 + constants.signals[result.signal] : 1);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stderr.write(
      `type-check: ${name(project.config)} ${status === 0 ? "ok" : `failed (exit ${status})`} in ${seconds} s\n`,
    );
    if (status === KILLED_STATUS) killedProject = project.config;
    return status;
  });

  if (outcome.skipped.length > 0 && killedProject === null) {
    process.stderr.write(
      `type-check: not checked, because a project they reference failed: ${outcome.skipped.map(name).join(", ")}\n`,
    );
  }
  if (killedProject !== null) {
    const report = describeToolMemoryKill({
      tool: "type-check",
      subject: `the compiler of ${name(killedProject)}`,
      subjectKilled: true,
      before: memoryBefore,
      after: readCgroupMemory(),
      steps: [
        `Split ${name(killedProject)} into smaller projects: each project's compiler holds the types of its own files and of the declarations it reads.`,
      ],
    });
    if (report) process.stderr.write(`\n${report}\n`);
  }
  return outcome.status;
}

// ===== Internal helpers =====

/** A shell's status for a process killed by SIGKILL, as the kernel's OOM killer does. */
const KILLED_STATUS = 128 + constants.signals.SIGKILL;

/**
 * Go's soft memory limit for one project's compiler below 16 GiB. The
 * backend's projects check in about 1 to 1.5 GiB at one checker under it.
 */
const PROJECT_GO_MEMORY_LIMIT_BYTES = 1280 * 1024 * 1024;

interface TsConfigFile {
  files?: unknown;
  include?: unknown;
  references?: { path: string }[];
}

function readConfig(file: string): TsConfigFile & { file: string } {
  return { ...parseJsonc(fs.readFileSync(file, "utf8"), file), file };
}

/** The absolute tsconfig paths a config references (a directory means its tsconfig.json). */
function referencesOf(config: TsConfigFile & { file: string }): string[] {
  return (config.references ?? []).map((reference) => {
    const target = path.resolve(path.dirname(config.file), reference.path);
    return target.endsWith(".json")
      ? target
      : path.join(target, "tsconfig.json");
  });
}

/** JSON with the comments and trailing commas tsconfig files allow. */
export function parseJsonc(text: string, file = "<jsonc>"): TsConfigFile {
  let json = "";
  // Where the last comma outside a string went, until something follows it.
  let pendingComma = -1;
  for (let index = 0; index < text.length; ) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (char === "}" || char === "]") {
      // A comma right before a closing bracket is a trailing one.
      if (pendingComma !== -1) {
        json = json.slice(0, pendingComma) + json.slice(pendingComma + 1);
      }
      pendingComma = -1;
      json += char;
      index++;
    } else if (/\s/.test(char)) {
      json += char;
      index++;
    } else {
      pendingComma = char === "," ? json.length : -1;
      if (char === '"') {
        const start = index++;
        while (index < text.length && text[index] !== '"') {
          index += text[index] === "\\" ? 2 : 1;
        }
        json += text.slice(start, ++index);
      } else {
        json += char;
        index++;
      }
    }
  }
  try {
    return JSON.parse(json) as TsConfigFile;
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`);
  }
}

/** Whether the args set one of these options, bare or as `--name=value`, in any case. */
function hasOption(args: string[], ...names: string[]): boolean {
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
