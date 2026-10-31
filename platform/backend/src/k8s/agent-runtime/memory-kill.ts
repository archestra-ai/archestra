/**
 * A memory kill inside a running pod. The kernel enforces a container's
 * memory limit by killing the largest process in its cgroup, not the
 * container: an agent whose type check or test run passes the limit loses
 * that process, its shell and the tmux server around them, while PID 1 lives
 * on and the pod stays Running. Nothing in the pod's status says so; the
 * cgroup's `memory.events` does: `oom_kill` counts processes killed by any
 * OOM killer, `oom` the times this cgroup hit its own limit.
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
  /** True when the cgroup hit its limit in between; false for a node that ran out of memory. */
  atLimit: boolean;
}

/** Runs in the pod's shell; its output is parsed by {@link parseMemoryEvents}. */
export const READ_MEMORY_EVENTS_COMMAND = [
  "/bin/sh",
  "-c",
  // memory.events has its own "max" counter, so the limit gets another name.
  'cat /sys/fs/cgroup/memory.events 2>/dev/null; printf "peak %s\\nlimit %s\\n" "$(cat /sys/fs/cgroup/memory.peak 2>/dev/null)" "$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"',
  "read-memory-events",
];

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
  return { events: after, atLimit: after.limitHits > before.limitHits };
}

/**
 * The failure reason for a run whose processes the kernel killed for memory.
 * A container that hit its own limit needs a larger tier; a node that ran out
 * of memory does not, and the run can simply start again.
 */
export function describeMemoryKill(
  kill: MemoryKill,
  container: string,
): string {
  const { events } = kill;
  const peak =
    events.peakBytes !== null
      ? ` (peak usage ${formatGibibytes(events.peakBytes)})`
      : "";
  if (kill.atLimit) {
    const limit =
      events.limitBytes !== null
        ? `reached its memory limit of ${formatGibibytes(events.limitBytes)}`
        : "hit its memory limit";
    return `The run ran out of memory. The ${container} container ${limit}${peak}, and the kernel killed the run's processes. Start the run again at a larger tier.`;
  }
  const limit =
    events.limitBytes !== null
      ? `did not hit its ${formatGibibytes(events.limitBytes)} limit`
      : "has no memory limit of its own";
  return `The kernel killed the run's processes because the node ran out of memory; the ${container} container ${limit}${peak}. Start the run again.`;
}

function formatGibibytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}
