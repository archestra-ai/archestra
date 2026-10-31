import os from "node:os";

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
  /** `process.constrainedMemory()`: the cgroup memory limit; 0 without one. */
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
 * The frontend suite's forks: half the CPUs, and no more than the memory
 * holds at about 2 GiB a JSDOM worker. On a machine the heap ceiling stays at
 * 8 GiB, which the JSDOM-heavy tests needed on Node 24; in a container the
 * kernel enforces the limit first, so the ceiling is each worker's share of
 * the budget.
 */
export function frontendVitestResourceLimits(envelope: ResourceEnvelope): {
  maxWorkers: number;
  maxOldSpaceMb: number;
} {
  const budgetBytes = envelope.totalMemoryBytes * FRONTEND_MEMORY_FRACTION;
  const cpuWorkers = Math.max(1, Math.floor(envelope.availableParallelism / 2));
  const memoryWorkers = Math.max(
    1,
    Math.floor(budgetBytes / FRONTEND_WORKER_RSS_BYTES),
  );
  const maxWorkers = Math.min(cpuWorkers, memoryWorkers);
  const maxOldSpaceMb = envelope.constrained
    ? Math.max(
        FRONTEND_MIN_OLD_SPACE_MB,
        Math.min(
          FRONTEND_MAX_OLD_SPACE_MB,
          Math.floor(budgetBytes / maxWorkers / BYTES_PER_MIB),
        ),
      )
    : FRONTEND_MAX_OLD_SPACE_MB;
  return { maxWorkers, maxOldSpaceMb };
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

const BYTES_PER_MIB = 1024 ** 2;
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
