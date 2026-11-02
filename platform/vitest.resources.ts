import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The CPUs and memory a Vitest run can count on, for the worker sizing in
 * each workspace's config.
 *
 * `os.availableParallelism()` and `os.totalmem()` describe the machine, and
 * inside a container they still do: an Agent Runtime pod at tier S (2 CPU
 * requested, 8Gi memory limit) on an 8-CPU, 32 GB node reports 8 CPUs and
 * 32 GB. The configs then sized their forks for the node, and the kernel
 * killed the pod once the forks and the pod's other processes passed 8Gi.
 *
 * The envelope is the smallest of the machine's figures, the cgroup memory
 * limit the process runs under (`process.constrainedMemory()`) and the size
 * the Agent Runtime gives its pod (`ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT`,
 * `ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST`). A runtime pod has no CPU limit,
 * so its CPU request is the share it can count on, as `scripts/dev-lite.sh`
 * and `e2e-tests/playwright.config.ts` already assume.
 */
export interface ResourceEnvelope {
  availableParallelism: number;
  totalMemoryBytes: number;
  /** True when a container or pod limit, not the machine, set the memory. */
  constrained: boolean;
}

export interface ResourceSignals {
  /** `os.availableParallelism()`: the machine's CPUs, or a cgroup CPU quota. */
  hostParallelism: number;
  /** `os.totalmem()`: the machine's memory. */
  hostMemoryBytes: number;
  /**
   * `process.constrainedMemory()`: the cgroup memory limit. Without one Node
   * reports 0 or, on Linux, the largest unsigned 64-bit value.
   */
  constrainedMemoryBytes: number | undefined;
  /** The pod's CPU request as a Kubernetes quantity ("2", "3500m"), when set. */
  podCpuRequest?: string;
  /** The pod's memory limit as a Kubernetes quantity ("8Gi"), when set. */
  podMemoryLimit?: string;
}

export function resourceEnvelope(signals: ResourceSignals): ResourceEnvelope {
  const memoryLimits = [
    signals.constrainedMemoryBytes ?? 0,
    parseMemoryQuantity(signals.podMemoryLimit),
  ].filter((bytes) => bytes > 0);
  const totalMemoryBytes = Math.min(signals.hostMemoryBytes, ...memoryLimits);
  const cpus = [
    signals.hostParallelism,
    parseCpuQuantity(signals.podCpuRequest),
  ].filter((count) => count > 0);
  return {
    availableParallelism: Math.max(1, Math.min(...cpus)),
    totalMemoryBytes,
    constrained: totalMemoryBytes < signals.hostMemoryBytes,
  };
}

export function detectResourceEnvelope(
  env: NodeJS.ProcessEnv = process.env,
): ResourceEnvelope {
  return resourceEnvelope({
    hostParallelism: os.availableParallelism(),
    hostMemoryBytes: os.totalmem(),
    constrainedMemoryBytes: process.constrainedMemory(),
    podCpuRequest: env.ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST,
    podMemoryLimit: env.ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT,
  });
}

/**
 * The frontend suite's forks. On a machine: half the CPUs and the 8 GiB heap
 * ceiling the JSDOM-heavy tests needed on Node 24, as before. In a container
 * the kernel enforces the memory limit first, so the forks are also no more
 * than the memory holds at about 2 GiB a JSDOM worker, and the heap ceiling
 * is each worker's share of the budget.
 */
export function frontendVitestResourceLimits(envelope: ResourceEnvelope): {
  maxWorkers: number;
  maxOldSpaceMb: number;
} {
  const cpuWorkers = Math.max(1, Math.floor(envelope.availableParallelism / 2));
  if (!envelope.constrained) {
    return { maxWorkers: cpuWorkers, maxOldSpaceMb: FRONTEND_MAX_OLD_SPACE_MB };
  }
  const budgetBytes = envelope.totalMemoryBytes * FRONTEND_MEMORY_FRACTION;
  const memoryWorkers = Math.max(
    1,
    Math.floor(budgetBytes / FRONTEND_WORKER_RSS_BYTES),
  );
  const maxWorkers = Math.min(cpuWorkers, memoryWorkers);
  const maxOldSpaceMb = Math.max(
    FRONTEND_MIN_OLD_SPACE_MB,
    Math.min(
      FRONTEND_MAX_OLD_SPACE_MB,
      Math.floor(budgetBytes / maxWorkers / BYTES_PER_MIB),
    ),
  );
  return { maxWorkers, maxOldSpaceMb };
}

/**
 * How many checkers the TypeScript 7 compiler runs for `pnpm type-check`;
 * null leaves its default of four. Each checker holds its own copy of the
 * checked types, so memory follows the count, not the CPUs. The backend, the
 * largest program, measured cold: one checker 6.0 GB, two 7.3 GB, four 9.3
 * GB. A run of an 8 GiB tier killed for memory during a review was running
 * the default. More checkers than CPUs only adds memory.
 */
export function typeScriptCheckers(envelope: ResourceEnvelope): number | null {
  const memory = envelope.totalMemoryBytes;
  const byMemory =
    memory < TYPESCRIPT_ONE_CHECKER_BELOW_BYTES
      ? 1
      : memory < TYPESCRIPT_FULL_MEMORY_BYTES
        ? 2
        : TYPESCRIPT_DEFAULT_CHECKERS;
  const checkers = Math.max(
    1,
    Math.min(byMemory, envelope.availableParallelism),
  );
  return checkers >= TYPESCRIPT_DEFAULT_CHECKERS ? null : checkers;
}

/**
 * How the TypeScript 7 compiler in `pnpm type-check` keeps its heap inside
 * the envelope; null from 16 GiB up, where it keeps Go's defaults and its
 * incremental build state.
 *
 * `goMemoryLimitBytes` is Go's soft memory limit (`GOMEMLIMIT`). Go collects
 * garbage when its heap doubles, so a compiler holding 5 GB of types can take
 * its whole pod before it collects. With the limit at five eighths of the
 * envelope it collects as it nears it and leaves the rest of the pod free.
 * The backend at one checker on 2 CPUs measured 5.8 to 6.2 GiB without the
 * limit and 5.3 GiB with 5 GiB, in about the same time. Below the program's
 * live data (about 5 GB for the backend) the limit still lowers the peak but
 * costs time: 4 GiB took the run from 35 s to 2.5 min and peaked at 5 GiB.
 *
 * `incremental` is false where one checker runs (under 12 GiB). Writing the
 * build state holds about 0.3 GB more at the backend's peak (5.6 against
 * 5.3 GiB with the limit). The state only speeds up a later run whose edits
 * stay in test files (8 s against 50 s); an edit to a source file that many
 * files import re-checks nearly the whole program either way.
 */
export function typeScriptMemorySettings(
  envelope: ResourceEnvelope,
): { goMemoryLimitBytes: number; incremental: boolean } | null {
  const memory = envelope.totalMemoryBytes;
  if (memory >= TYPESCRIPT_FULL_MEMORY_BYTES) return null;
  return {
    goMemoryLimitBytes: Math.floor(
      memory * TYPESCRIPT_GO_MEMORY_LIMIT_FRACTION,
    ),
    incremental: memory >= TYPESCRIPT_ONE_CHECKER_BELOW_BYTES,
  };
}

/**
 * The memory counters of the cgroup a process runs in (cgroup v2). A
 * container's memory limit is enforced by the kernel, which kills a process in
 * it once the container reaches the limit; the killed command only says
 * "Killed". A tool reads these before and after its child runs to say whether
 * memory was the reason, and what to change.
 */
export interface CgroupMemory {
  /** Processes of the cgroup an OOM killer killed (`memory.events` oom_kill). */
  oomKills: number;
  /** Times the cgroup reached its memory limit (`memory.events` oom). */
  limitHits: number;
  /** The highest usage seen (`memory.peak`), when the kernel gives it. */
  peakBytes: number | null;
  /** The limit (`memory.max`), or null without one. */
  limitBytes: number | null;
}

/**
 * The counters of this process's own cgroup, or of `dir`; null outside a
 * cgroup v2 hierarchy, or when the cgroup has no memory controller.
 */
export function readCgroupMemory(
  dir: string = ownCgroupDirectory(),
): CgroupMemory | null {
  const events = readText(path.join(dir, "memory.events"));
  if (events === null) return null;
  const counters = new Map<string, number>();
  for (const line of events.split("\n")) {
    const match = line.trim().match(/^(\S+) (\d+)$/);
    if (match) counters.set(match[1] as string, Number(match[2]));
  }
  const oomKills = counters.get("oom_kill");
  if (oomKills === undefined) return null;
  return {
    oomKills,
    limitHits: counters.get("oom") ?? 0,
    peakBytes: readBytes(path.join(dir, "memory.peak")),
    limitBytes: readBytes(path.join(dir, "memory.max")),
  };
}

/**
 * What a tool prints when the kernel killed its child, or another process of
 * the container, for memory while the child ran; null when the counters did
 * not move or cannot be read. It names what was killed, the limit, the peak
 * and the runtime tier, and what to change: run less at once, give the tool
 * fewer workers, or move to a larger tier.
 */
export function describeToolMemoryKill(params: {
  /** The tool printing it, as the reader called it: "type-check". */
  tool: string;
  /** What the tool ran: "tsc", "the tests". */
  subject: string;
  /** Whether the subject itself died by SIGKILL (exit status 137). */
  subjectKilled: boolean;
  before: CgroupMemory | null;
  after: CgroupMemory | null;
  /** Ways to make this tool use less, most specific first. */
  steps: string[];
  env?: NodeJS.ProcessEnv;
}): string | null {
  const { before, after } = params;
  if (!before || !after || after.oomKills <= before.oomKills) return null;
  const env = params.env ?? process.env;
  const killed = after.oomKills - before.oomKills;
  const atLimit = after.limitHits > before.limitHits;
  const tier = env.ARCHESTRA_AGENT_RUNTIME_TIER?.trim();
  const peak =
    after.peakBytes !== null
      ? ` (peak usage ${formatGibibytes(after.peakBytes)})`
      : "";
  const what = params.subjectKilled
    ? `${params.subject} was killed for memory`
    : `the kernel killed ${killed === 1 ? "a process" : `${killed} processes`} in this container for memory while ${params.subject} ran`;
  const why = atLimit
    ? after.limitBytes !== null
      ? `this container reached its memory limit of ${formatLimitGibibytes(after.limitBytes)}${tier ? ` at tier ${tier}` : ""}${peak}`
      : `this container reached its memory limit${peak}`
    : `the machine ran out of memory${after.limitBytes !== null ? `; this container stayed under its ${formatLimitGibibytes(after.limitBytes)} limit${peak}` : ""}`;
  if (!atLimit) {
    return `${params.tool}: ${what}: ${why}. Run it again.`;
  }
  const steps = [
    "Run type checks, test suites and builds one at a time, not side by side.",
    ...params.steps,
    largerTierStep(env),
  ];
  return [
    `${params.tool}: ${what}: ${why}.`,
    "To fit in memory:",
    ...steps.map((step) => `  - ${step}`),
  ].join("\n");
}

/**
 * Prints {@link describeToolMemoryKill} when this process exits with a
 * failure after the kernel killed something for memory: a test runner whose
 * worker was killed reports only a worker that exited unexpectedly.
 */
export function reportMemoryKillsAtExit(params: {
  tool: string;
  subject: string;
  steps: string[];
}): void {
  const registry = globalThis as { [MEMORY_KILL_REPORT]?: true };
  if (registry[MEMORY_KILL_REPORT]) return;
  const before = readCgroupMemory();
  if (!before) return;
  registry[MEMORY_KILL_REPORT] = true;
  process.once("exit", (code) => {
    if (code === 0) return;
    const report = describeToolMemoryKill({
      ...params,
      subjectKilled: false,
      before,
      after: readCgroupMemory(),
    });
    if (report) process.stderr.write(`\n${report}\n`);
  });
}

/** Bytes of a Kubernetes memory quantity ("8Gi", "512Mi", "8G"); 0 when unreadable. */
export function parseMemoryQuantity(quantity: string | undefined): number {
  const match = quantity
    ?.trim()
    .match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/);
  if (!match) return 0;
  const [, amount, unit = ""] = match;
  return Math.floor(Number(amount) * (MEMORY_UNITS[unit] ?? 0));
}

/** Whole CPUs of a Kubernetes CPU quantity ("2", "3.5", "500m"); 0 when unreadable. */
export function parseCpuQuantity(quantity: string | undefined): number {
  const match = quantity?.trim().match(/^(\d+(?:\.\d+)?)(m)?$/);
  if (!match) return 0;
  const [, amount, milli] = match;
  const cpus = milli ? Number(amount) / 1000 : Number(amount);
  return cpus > 0 ? Math.max(1, Math.floor(cpus)) : 0;
}

// ===== Internal helpers =====

/** The directory of this process's cgroup v2: `/proc/self/cgroup` names it. */
function ownCgroupDirectory(): string {
  const entry = readText("/proc/self/cgroup")
    ?.split("\n")
    .find((line) => line.startsWith("0::"));
  return path.join("/sys/fs/cgroup", entry?.slice(3).trim() || "/");
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readBytes(file: string): number | null {
  const text = readText(file)?.trim();
  return text && /^\d+$/.test(text) ? Number(text) : null;
}

function formatGibibytes(bytes: number): string {
  return `${Math.round((bytes / BYTES_PER_GIB) * 10) / 10} GiB`;
}

/** A limit, rounded down: it never reads as more than the container had. */
function formatLimitGibibytes(bytes: number): string {
  // The epsilon keeps an exact 8 GiB from flooring to 7.9 on a rounding error.
  return `${Math.floor((bytes / BYTES_PER_GIB) * 10 + 1e-9) / 10} GiB`;
}

/**
 * The tier to move to, from the tiers an Agent Runtime run may use
 * (`ARCHESTRA_AGENT_RUNTIME_TIERS`, smallest first, `current` on its own).
 */
function largerTierStep(env: NodeJS.ProcessEnv): string {
  let tiers: Array<{
    name?: unknown;
    memory_limit_gib?: unknown;
    current?: unknown;
  }> = [];
  try {
    const parsed: unknown = JSON.parse(
      env.ARCHESTRA_AGENT_RUNTIME_TIERS ?? "[]",
    );
    if (Array.isArray(parsed)) tiers = parsed;
  } catch {
    tiers = [];
  }
  const current = tiers.findIndex((tier) => tier?.current === true);
  if (current === -1) return "Or give it more memory.";
  const limitOf = (tier: (typeof tiers)[number] | undefined) =>
    typeof tier?.memory_limit_gib === "number" ? tier.memory_limit_gib : null;
  const currentLimit = limitOf(tiers[current]);
  // The list is smallest first; a tier with more CPU and the same memory
  // would be killed the same way.
  const larger = tiers.slice(current + 1).find((tier) => {
    const limit = limitOf(tier);
    return (
      typeof tier?.name === "string" &&
      (limit === null || currentLimit === null || limit > currentLimit)
    );
  });
  if (!larger) {
    return `This run is at ${String(tiers[current]?.name)}, and no tier this agent may use has more memory.`;
  }
  const limit = limitOf(larger);
  return `Or move the work to a larger tier: start a run of this agent at ${String(larger.name)}${limit === null ? "" : `, which has a memory limit of ${limit} GiB,`} and hand over the branch.`;
}

const MEMORY_KILL_REPORT = Symbol.for("archestra.memoryKillReport");
const BYTES_PER_MIB = 1024 ** 2;
const BYTES_PER_GIB = 1024 ** 3;
const TYPESCRIPT_DEFAULT_CHECKERS = 4;
/** From here up the compiler runs four checkers with Go's defaults. */
const TYPESCRIPT_FULL_MEMORY_BYTES = 16 * BYTES_PER_GIB;
/** Below this the compiler runs one checker without incremental build state. */
const TYPESCRIPT_ONE_CHECKER_BELOW_BYTES = 12 * BYTES_PER_GIB;
const TYPESCRIPT_GO_MEMORY_LIMIT_FRACTION = 5 / 8;
const MEMORY_UNITS: Record<string, number> = {
  "": 1,
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

const FRONTEND_MEMORY_FRACTION = 0.5;
const FRONTEND_WORKER_RSS_BYTES = 2 * 1024 ** 3;
const FRONTEND_MIN_OLD_SPACE_MB = 1536;
const FRONTEND_MAX_OLD_SPACE_MB = 8192;
