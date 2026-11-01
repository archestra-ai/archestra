/**
 * A memory kill inside a running pod. The kernel enforces a container's
 * memory limit by killing processes in its cgroup. With the kubelet's default
 * on cgroup v2 (`memory.oom.group`) it kills every process in the container,
 * PID 1 included, and the container exits: `pod-failure.ts` reports that from
 * the pod's status. With single-process OOM kills it kills only the largest
 * process, often the agent's type check or test run, and the container lives
 * on. Nothing in the pod's status says so then; the cgroup's `memory.events`
 * does: `oom_kill` counts processes killed by any OOM killer, `oom` the times
 * this cgroup hit its own limit.
 */
export interface MemoryEvents {
  /** Processes of the cgroup killed by an OOM killer, the node's included. */
  oomKills: number;
  /** Times the cgroup hit its own memory limit. */
  limitHits: number;
  /** The highest usage seen, when the kernel exposes it. */
  peakBytes: number | null;
  /** The limit, or null without one. */
  limitBytes: number | null;
}

/** A kill between two readings, and whether the container's own limit caused it. */
export interface MemoryKill {
  events: MemoryEvents;
  /** Processes the kernel killed between the two readings. */
  killed: number;
  /** True when the cgroup hit its limit in between; false for a node that ran out of memory. */
  atLimit: boolean;
}

/** Prints the cgroup's counters, peak and limit for {@link parseMemoryEvents}. */
export const MEMORY_EVENTS_SCRIPT =
  // memory.events has its own "max" counter, so the limit gets another name.
  'cat /sys/fs/cgroup/memory.events 2>/dev/null; printf "peak %s\\nlimit %s\\n" "$(cat /sys/fs/cgroup/memory.peak 2>/dev/null)" "$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"';

/** Runs in the pod's shell; its output is parsed by {@link parseMemoryEvents}. */
export const READ_MEMORY_EVENTS_COMMAND = [
  "/bin/sh",
  "-c",
  MEMORY_EVENTS_SCRIPT,
  "read-memory-events",
];

/**
 * Ends the counters in a completion poll's output. The poll reads them with
 * the turn's result in one exec, so a memory kill is seen as it happens
 * without a second command per poll.
 */
export const TURN_RESULT_SEPARATOR = "--- archestra turn result ---";

/**
 * A completion poll's output: the counters before {@link TURN_RESULT_SEPARATOR}
 * and the turn's result after it. Output without the separator is the result
 * alone, with no counters.
 */
export function splitTurnPoll(output: string): {
  memory: MemoryEvents | null;
  result: string;
} {
  const lines = output.split("\n");
  const separator = lines.findIndex(
    (line) => line.trim() === TURN_RESULT_SEPARATOR,
  );
  if (separator === -1) return { memory: null, result: output };
  return {
    memory: parseMemoryEvents(lines.slice(0, separator).join("\n")),
    result: lines.slice(separator + 1).join("\n"),
  };
}

/** The counters of `memory.events`, peak and limit; null when the output has no counters. */
export function parseMemoryEvents(output: string): MemoryEvents | null {
  const fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+(\S+)$/);
    if (match) fields.set(match[1] as string, match[2] as string);
  }
  const oomKills = fields.get("oom_kill");
  if (oomKills === undefined || !/^\d+$/.test(oomKills)) return null;
  const count = (field: string): number => {
    const value = fields.get(field);
    return value && /^\d+$/.test(value) ? Number(value) : 0;
  };
  const bytes = (field: string): number | null => {
    const value = fields.get(field);
    return value && /^\d+$/.test(value) ? Number(value) : null;
  };
  return {
    oomKills: Number(oomKills),
    limitHits: count("oom"),
    peakBytes: bytes("peak"),
    limitBytes: bytes("limit"),
  };
}

/**
 * Whether the run's processes were killed for memory between two readings:
 * the one taken when the turn was first seen running, and a later one. Both
 * are required: a retained workspace killed in an earlier turn carries that
 * count, and without the first reading it would be blamed again.
 */
export function memoryKillBetween(
  before: MemoryEvents | null,
  after: MemoryEvents | null,
): MemoryKill | null {
  if (!before || !after || after.oomKills <= before.oomKills) return null;
  return {
    events: after,
    killed: after.oomKills - before.oomKills,
    atLimit: after.limitHits > before.limitHits,
  };
}

/**
 * The failure reason for a run whose processes the kernel killed for memory.
 * A container that hit its own limit needs a larger tier or less at once; a
 * node that ran out of memory does not, and the run can simply start again.
 * The limit is named as "memory limit of 8 GiB": clients read the size the
 * run had from it.
 */
export function describeMemoryKill(
  kill: MemoryKill,
  where: {
    container: string;
    /** The runtime tier the pod runs at, when it says. */
    tier: string | null;
  },
): string {
  const { events } = kill;
  const peak =
    events.peakBytes !== null
      ? ` (peak usage ${formatGibibytes(events.peakBytes)})`
      : "";
  const tier = where.tier ? ` at tier ${where.tier}` : "";
  const processes =
    kill.killed === 1 ? "a process" : `${kill.killed} processes`;
  if (kill.atLimit) {
    const limit =
      events.limitBytes !== null
        ? `reached its memory limit of ${formatGibibytes(events.limitBytes)}${tier}`
        : `hit its memory limit${tier}`;
    return `The run ran out of memory. The ${where.container} container ${limit}${peak}, and the kernel killed ${processes} of the run. ${MEMORY_KILL_NEXT_STEP}`;
  }
  const limit =
    events.limitBytes !== null
      ? `did not reach its ${formatGibibytes(events.limitBytes)} limit${tier}`
      : `has no memory limit of its own${tier}`;
  return `The kernel killed ${processes} of the run because the node ran out of memory; the ${where.container} container ${limit}${peak}. Start the run again.`;
}

/** What to do about a container that reached its memory limit. */
export const MEMORY_KILL_NEXT_STEP =
  "Start the run again at a larger tier, or have the agent run memory-heavy commands, such as type checks, test suites and builds, one at a time and with fewer workers.";

/** Bytes of a Kubernetes memory quantity ("8Gi", "8589934592", "8G"); null when unreadable. */
export function parseMemoryQuantity(
  quantity: string | undefined,
): number | null {
  const match = quantity
    ?.trim()
    .match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/);
  if (!match) return null;
  const [, amount, unit = ""] = match;
  return Math.floor(Number(amount) * (MEMORY_UNITS[unit] ?? 1));
}

/** "8 GiB", "7.5 GiB": one decimal at most, none when it is zero. */
export function formatGibibytes(bytes: number): string {
  return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GiB`;
}

// ===================== internals =====================

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
