import { describe, expect, test } from "vitest";
import {
  describeMemoryKill,
  memoryKillBetween,
  parseMemoryEvents,
} from "./memory-kill";

const GIB = 1024 ** 3;

describe("parseMemoryEvents", () => {
  test("reads the counters, the peak and the limit", () => {
    expect(
      parseMemoryEvents(
        "low 0\nhigh 0\nmax 1203\noom 3\noom_kill 1\noom_group_kill 0\npeak 8589934592\nlimit 8589934592\n",
      ),
    ).toEqual({
      oomKills: 1,
      limitHits: 3,
      peakBytes: 8 * GIB,
      limitBytes: 8 * GIB,
    });
  });

  test("keeps the limit and peak open when the kernel does not give them", () => {
    // memory.events' own "max" counter is not the limit.
    expect(
      parseMemoryEvents("max 1203\noom_kill 2\npeak \nlimit max\n"),
    ).toEqual({ oomKills: 2, limitHits: 0, peakBytes: null, limitBytes: null });
  });

  test("is null without a counter (no cgroup v2, an older image shell)", () => {
    expect(parseMemoryEvents("")).toBeNull();
    expect(parseMemoryEvents("peak 10\nlimit max\n")).toBeNull();
  });
});

describe("memoryKillBetween", () => {
  const before = {
    oomKills: 1,
    limitHits: 1,
    peakBytes: null,
    limitBytes: 8 * GIB,
  };
  test("is the later reading when a kill happened in between, with whether the limit caused it", () => {
    const atLimit = {
      ...before,
      oomKills: 2,
      limitHits: 2,
      peakBytes: 8 * GIB,
    };
    expect(memoryKillBetween(before, atLimit)).toEqual({
      events: atLimit,
      atLimit: true,
    });
    // The node's OOM killer: the cgroup never hit its own limit.
    const nodeOom = { ...before, oomKills: 2, peakBytes: 3 * GIB };
    expect(memoryKillBetween(before, nodeOom)).toEqual({
      events: nodeOom,
      atLimit: false,
    });
  });
  test("is null when nothing was killed since, or a reading is missing", () => {
    expect(memoryKillBetween(before, before)).toBeNull();
    // A retained workspace's earlier kill is not this turn's without a first reading.
    expect(memoryKillBetween(null, { ...before, oomKills: 2 })).toBeNull();
    expect(memoryKillBetween(before, null)).toBeNull();
  });
});

describe("describeMemoryKill", () => {
  test("names the limit, the peak and a larger tier for a container that hit its limit", () => {
    expect(
      describeMemoryKill(
        {
          events: {
            oomKills: 1,
            limitHits: 1,
            peakBytes: 7.5 * GIB,
            limitBytes: 8 * GIB,
          },
          atLimit: true,
        },
        "agent-runtime",
      ),
    ).toBe(
      "The run ran out of memory. The agent-runtime container reached its memory limit of 8 GiB (peak usage 7.5 GiB), and the kernel killed the run's processes. Start the run again at a larger tier.",
    );
    expect(
      describeMemoryKill(
        {
          events: {
            oomKills: 1,
            limitHits: 1,
            peakBytes: null,
            limitBytes: null,
          },
          atLimit: true,
        },
        "agent-runtime",
      ),
    ).toBe(
      "The run ran out of memory. The agent-runtime container hit its memory limit, and the kernel killed the run's processes. Start the run again at a larger tier.",
    );
  });

  test("blames the node, not the size, when the container stayed under its limit", () => {
    expect(
      describeMemoryKill(
        {
          events: {
            oomKills: 1,
            limitHits: 0,
            peakBytes: 3 * GIB,
            limitBytes: 8 * GIB,
          },
          atLimit: false,
        },
        "agent-runtime",
      ),
    ).toBe(
      "The kernel killed the run's processes because the node ran out of memory; the agent-runtime container stayed under its 8 GiB limit (peak usage 3 GiB). Start the run again.",
    );
    expect(
      describeMemoryKill(
        {
          events: {
            oomKills: 1,
            limitHits: 0,
            peakBytes: null,
            limitBytes: null,
          },
          atLimit: false,
        },
        "agent-runtime",
      ),
    ).toBe(
      "The kernel killed the run's processes because the node ran out of memory; the agent-runtime container has no memory limit of its own. Start the run again.",
    );
  });
});
