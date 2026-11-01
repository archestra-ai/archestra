import { describe, expect, test } from "vitest";
import {
  describeMemoryKill,
  memoryKillBetween,
  parseMemoryEvents,
  parseMemoryQuantity,
  splitTurnPoll,
  TURN_RESULT_SEPARATOR,
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

describe("splitTurnPoll", () => {
  test("separates the counters from the turn's result", () => {
    expect(
      splitTurnPoll(
        `low 0\nmax 4\noom 1\noom_kill 1\npeak ${8 * GIB}\nlimit ${8 * GIB}\n${TURN_RESULT_SEPARATOR}\n75\n{"code":"runtime.pane_exited"}\n`,
      ),
    ).toEqual({
      memory: {
        oomKills: 1,
        limitHits: 1,
        peakBytes: 8 * GIB,
        limitBytes: 8 * GIB,
      },
      result: '75\n{"code":"runtime.pane_exited"}\n',
    });
  });

  test("has no counters but keeps the result when the container has none", () => {
    // No cgroup v2: the cat finds nothing, only peak and limit are printed.
    expect(splitTurnPoll(`peak \nlimit \n${TURN_RESULT_SEPARATOR}\n`)).toEqual({
      memory: null,
      result: "",
    });
  });

  test("reads output without the separator as the result alone", () => {
    expect(splitTurnPoll("0\n")).toEqual({ memory: null, result: "0\n" });
  });
});

describe("memoryKillBetween", () => {
  const before = {
    oomKills: 1,
    limitHits: 1,
    peakBytes: null,
    limitBytes: 8 * GIB,
  };
  test("is the later reading when a kill happened in between, with how many and whether the limit caused it", () => {
    const atLimit = {
      ...before,
      oomKills: 3,
      limitHits: 2,
      peakBytes: 8 * GIB,
    };
    expect(memoryKillBetween(before, atLimit)).toEqual({
      events: atLimit,
      killed: 2,
      atLimit: true,
    });
    // The node's OOM killer: the cgroup never hit its own limit.
    const nodeOom = { ...before, oomKills: 2, peakBytes: 3 * GIB };
    expect(memoryKillBetween(before, nodeOom)).toEqual({
      events: nodeOom,
      killed: 1,
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
  const where = { container: "agent-runtime", tier: "S" };
  test("names the limit, the tier, the peak and what to do for a container that hit its limit", () => {
    const description = describeMemoryKill(
      {
        events: {
          oomKills: 1,
          limitHits: 1,
          peakBytes: 7.97 * GIB,
          limitBytes: 8 * GIB,
        },
        killed: 1,
        atLimit: true,
      },
      where,
    );
    expect(description).toBe(
      "The run ran out of memory. The agent-runtime container reached its memory limit of 8 GiB at tier S (peak usage 8 GiB), and the kernel killed a process of the run. Start the run again at a larger tier, or have the agent run memory-heavy commands, such as type checks, test suites and builds, one at a time and with fewer workers.",
    );
    // code-review-action reads the killed run's size from the reason with
    // this pattern (src/sizes.ts) to ask for a larger tier.
    expect(
      description.match(
        /memory limit(?: of)? (\d+(?:\.\d+)?) ?(GiB|Gi|MiB|Mi)\b/i,
      )?.[1],
    ).toBe("8");
    expect(
      describeMemoryKill(
        {
          events: {
            oomKills: 3,
            limitHits: 1,
            peakBytes: null,
            limitBytes: null,
          },
          killed: 3,
          atLimit: true,
        },
        { container: "agent-runtime", tier: null },
      ),
    ).toMatch(
      /^The run ran out of memory\. The agent-runtime container hit its memory limit, and the kernel killed 3 processes of the run\. Start the run again at a larger tier/,
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
          killed: 1,
          atLimit: false,
        },
        where,
      ),
    ).toBe(
      "The kernel killed a process of the run because the node ran out of memory; the agent-runtime container did not reach its 8 GiB limit at tier S (peak usage 3 GiB). Start the run again.",
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
          killed: 1,
          atLimit: false,
        },
        { container: "agent-runtime", tier: null },
      ),
    ).toBe(
      "The kernel killed a process of the run because the node ran out of memory; the agent-runtime container has no memory limit of its own. Start the run again.",
    );
  });
});

describe("parseMemoryQuantity", () => {
  test("reads binary and decimal quantities and plain bytes", () => {
    expect(parseMemoryQuantity("8Gi")).toBe(8 * GIB);
    expect(parseMemoryQuantity("14336Mi")).toBe(14 * GIB);
    expect(parseMemoryQuantity("8G")).toBe(8 * 1000 ** 3);
    expect(parseMemoryQuantity("8589934592")).toBe(8 * GIB);
    expect(parseMemoryQuantity("lots")).toBeNull();
    expect(parseMemoryQuantity(undefined)).toBeNull();
  });
});
