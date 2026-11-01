import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  describeToolMemoryKill,
  frontendVitestResourceLimits,
  parseCpuQuantity,
  parseMemoryQuantity,
  readCgroupMemory,
  resourceEnvelope,
  typeScriptCheckers,
} from "../../../vitest.resources";
import { calculateVitestResourceLimits } from "./vitest-resource-limits";

const GIB = 1024 ** 3;

// An n2d-standard-8 node of the staging runtime pool, as the pod sees it.
const NODE = { hostParallelism: 8, hostMemoryBytes: 32 * GIB };

describe("resourceEnvelope", () => {
  test("is the machine when nothing constrains the process", () => {
    // Node reports no constraint as 0 or, on Linux without a cgroup limit, as
    // the largest unsigned 64-bit value.
    for (const constrainedMemoryBytes of [0, 18_446_744_073_709_552_000]) {
      expect(
        resourceEnvelope({
          hostParallelism: 32,
          hostMemoryBytes: 62 * GIB,
          constrainedMemoryBytes,
        }),
      ).toEqual({
        availableParallelism: 32,
        totalMemoryBytes: 62 * GIB,
        constrained: false,
      });
    }
  });

  test("takes the cgroup memory limit and the pod's CPU request in a runtime pod", () => {
    // Tier S: 2 CPU requested, no CPU limit, 8Gi memory limit. Node reports
    // the node's CPUs and the cgroup limit; the Agent Runtime names both.
    expect(
      resourceEnvelope({
        ...NODE,
        constrainedMemoryBytes: 8 * GIB,
        podCpuRequest: "2",
        podMemoryLimit: "8Gi",
      }),
    ).toEqual({
      availableParallelism: 2,
      totalMemoryBytes: 8 * GIB,
      constrained: true,
    });
  });

  test("uses the pod's limit when the process cannot read its cgroup", () => {
    expect(
      resourceEnvelope({
        ...NODE,
        constrainedMemoryBytes: undefined,
        podCpuRequest: "3500m",
        podMemoryLimit: "18Gi",
      }),
    ).toEqual({
      availableParallelism: 3,
      totalMemoryBytes: 18 * GIB,
      constrained: true,
    });
  });

  test("keeps the smaller figure when the signals disagree", () => {
    expect(
      resourceEnvelope({
        ...NODE,
        constrainedMemoryBytes: 16 * GIB,
        podMemoryLimit: "8Gi",
      }),
    ).toMatchObject({ availableParallelism: 8, totalMemoryBytes: 8 * GIB });
  });

  test("never reports less than one CPU", () => {
    expect(
      resourceEnvelope({
        ...NODE,
        constrainedMemoryBytes: 0,
        podCpuRequest: "500m",
      }).availableParallelism,
    ).toBe(1);
  });
});

describe("Kubernetes quantities", () => {
  test("memory", () => {
    expect(parseMemoryQuantity("8Gi")).toBe(8 * GIB);
    expect(parseMemoryQuantity("512Mi")).toBe(512 * 1024 ** 2);
    expect(parseMemoryQuantity("1.5Gi")).toBe(1.5 * GIB);
    expect(parseMemoryQuantity("8G")).toBe(8_000_000_000);
    expect(parseMemoryQuantity("1024")).toBe(1024);
    expect(parseMemoryQuantity(undefined)).toBe(0);
    expect(parseMemoryQuantity("lots")).toBe(0);
  });

  test("cpu", () => {
    expect(parseCpuQuantity("2")).toBe(2);
    expect(parseCpuQuantity("3.5")).toBe(3);
    expect(parseCpuQuantity("3500m")).toBe(3);
    expect(parseCpuQuantity("500m")).toBe(1);
    expect(parseCpuQuantity("0")).toBe(0);
    expect(parseCpuQuantity(undefined)).toBe(0);
  });
});

describe("sizing inside an Agent Runtime pod", () => {
  const tierS = resourceEnvelope({
    ...NODE,
    constrainedMemoryBytes: 8 * GIB,
    podCpuRequest: "2",
    podMemoryLimit: "8Gi",
  });
  const tierM = resourceEnvelope({
    ...NODE,
    constrainedMemoryBytes: 16 * GIB,
    podCpuRequest: "4",
    podMemoryLimit: "16Gi",
  });

  test("the backend suite gets one fork with a 2 GiB heap at tier S", () => {
    expect(calculateVitestResourceLimits({ isCI: false, ...tierS })).toEqual({
      maxWorkers: 1,
      maxOldSpaceMb: 2048,
    });
    // Sized for the node instead, the same pod got two forks of 3 GiB each.
    expect(
      calculateVitestResourceLimits({
        isCI: false,
        availableParallelism: NODE.hostParallelism,
        totalMemoryBytes: NODE.hostMemoryBytes,
      }),
    ).toEqual({ maxWorkers: 2, maxOldSpaceMb: 3072 });
  });

  test("the frontend suite gets one fork with a 4 GiB heap at tier S and two at tier M", () => {
    expect(frontendVitestResourceLimits(tierS)).toEqual({
      maxWorkers: 1,
      maxOldSpaceMb: 4096,
    });
    expect(frontendVitestResourceLimits(tierM)).toEqual({
      maxWorkers: 2,
      maxOldSpaceMb: 4096,
    });
  });

  test("the frontend suite keeps half the cores and the 8 GiB ceiling on a machine", () => {
    const laptop = resourceEnvelope({
      hostParallelism: 8,
      hostMemoryBytes: 16 * GIB,
      constrainedMemoryBytes: 0,
    });
    expect(frontendVitestResourceLimits(laptop)).toEqual({
      maxWorkers: 4,
      maxOldSpaceMb: 8192,
    });
    const workstation = resourceEnvelope({
      hostParallelism: 32,
      hostMemoryBytes: 62 * GIB,
      constrainedMemoryBytes: 0,
    });
    expect(frontendVitestResourceLimits(workstation)).toEqual({
      maxWorkers: 16,
      maxOldSpaceMb: 8192,
    });
  });
});

describe("typeScriptCheckers", () => {
  const envelope = (memoryGiB: number, cpus: number) => ({
    availableParallelism: cpus,
    totalMemoryBytes: memoryGiB * GIB,
    constrained: true,
  });

  test("runs one checker in a pod of tier S and two in tier M", () => {
    // Staging tiers: S 2 CPU / 8Gi, M 3.5 CPU / 14Gi, L 6 CPU / 24Gi.
    expect(typeScriptCheckers(envelope(8, 2))).toBe(1);
    expect(typeScriptCheckers(envelope(14, 4))).toBe(2);
    expect(typeScriptCheckers(envelope(24, 6))).toBeNull();
  });

  test("keeps the compiler's default on a machine with the memory for it", () => {
    expect(typeScriptCheckers(envelope(16, 4))).toBeNull();
    expect(typeScriptCheckers(envelope(62, 32))).toBeNull();
  });

  test("runs no more checkers than CPUs", () => {
    expect(typeScriptCheckers(envelope(62, 1))).toBe(1);
    expect(typeScriptCheckers(envelope(62, 2))).toBe(2);
  });
});

describe("readCgroupMemory", () => {
  test("reads the kill counters, the peak and the limit of a cgroup", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cgroup-"));
    try {
      writeFileSync(
        path.join(dir, "memory.events"),
        "low 0\nhigh 0\nmax 14021\noom 3\noom_kill 2\noom_group_kill 0\n",
      );
      writeFileSync(path.join(dir, "memory.peak"), `${8 * GIB}\n`);
      writeFileSync(path.join(dir, "memory.max"), "max\n");
      expect(readCgroupMemory(dir)).toEqual({
        oomKills: 2,
        limitHits: 3,
        peakBytes: 8 * GIB,
        // "max" is no limit.
        limitBytes: null,
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("is null where there is no cgroup v2 memory controller", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cgroup-"));
    try {
      expect(readCgroupMemory(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("describeToolMemoryKill", () => {
  const before = {
    oomKills: 0,
    limitHits: 10,
    peakBytes: 5 * GIB,
    limitBytes: 8 * GIB,
  };
  const atLimit = {
    oomKills: 1,
    limitHits: 11,
    peakBytes: 8 * GIB,
    limitBytes: 8 * GIB,
  };
  // What a pod of tier S sees: its tier and the tiers it may move to.
  const env = {
    ARCHESTRA_AGENT_RUNTIME_TIER: "S",
    ARCHESTRA_AGENT_RUNTIME_TIERS: JSON.stringify([
      { name: "S", cpu: 2, memory_gib: 4, memory_limit_gib: 8, current: true },
      { name: "M", cpu: 3.5, memory_gib: 7, memory_limit_gib: 14 },
    ]),
  };
  const typeCheck = {
    tool: "type-check",
    subject: "tsc",
    steps: ["Give the compiler one checker: add --checkers 1."],
    env,
  };

  test("names the killed command, the limit, the tier, the peak and what to change", () => {
    expect(
      describeToolMemoryKill({
        ...typeCheck,
        subjectKilled: true,
        before,
        after: atLimit,
      }),
    ).toBe(
      [
        "type-check: tsc was killed for memory: this container reached its memory limit of 8 GiB at tier S (peak usage 8 GiB).",
        "To fit in memory:",
        "  - Run type checks, test suites and builds one at a time, not side by side.",
        "  - Give the compiler one checker: add --checkers 1.",
        "  - Or move the work to a larger tier: start a run of this agent at M, which has a memory limit of 14 GiB, and hand over the branch.",
      ].join("\n"),
    );
  });

  test("says another process was killed when the command itself was not", () => {
    expect(
      describeToolMemoryKill({
        ...typeCheck,
        subjectKilled: false,
        before,
        after: { ...atLimit, oomKills: 2 },
      })?.split("\n")[0],
    ).toBe(
      "type-check: the kernel killed 2 processes in this container for memory while tsc ran: this container reached its memory limit of 8 GiB at tier S (peak usage 8 GiB).",
    );
  });

  test("rounds the limit down, never up", () => {
    // A container limited to 8G: 8,000,000,000 bytes, 7.45 GiB.
    const decimal = { ...atLimit, limitBytes: 8_000_000_000 };
    expect(
      describeToolMemoryKill({
        ...typeCheck,
        subjectKilled: true,
        before: { ...before, limitBytes: 8_000_000_000 },
        after: decimal,
      })?.split("\n")[0],
    ).toContain("memory limit of 7.4 GiB at tier S");
  });

  test("blames the machine, not the container, when the limit was not reached", () => {
    expect(
      describeToolMemoryKill({
        ...typeCheck,
        subjectKilled: true,
        before,
        after: { ...before, oomKills: 1, peakBytes: 3 * GIB },
      }),
    ).toBe(
      "type-check: tsc was killed for memory: the machine ran out of memory; this container stayed under its 8 GiB limit (peak usage 3 GiB). Run it again.",
    );
  });

  test("offers only a tier with more memory, none at the largest, and more memory outside a runtime", () => {
    const largest = describeToolMemoryKill({
      ...typeCheck,
      subjectKilled: true,
      before,
      after: atLimit,
      env: {
        ARCHESTRA_AGENT_RUNTIME_TIER: "M",
        ARCHESTRA_AGENT_RUNTIME_TIERS: JSON.stringify([
          { name: "S", memory_limit_gib: 8 },
          { name: "M", memory_limit_gib: 14, current: true },
        ]),
      },
    });
    expect(largest?.split("\n").at(-1)).toBe(
      "  - This run is at M, and no tier this agent may use has more memory.",
    );
    // A next tier with more CPU and the same memory would be killed the same way.
    const sameMemory = describeToolMemoryKill({
      ...typeCheck,
      subjectKilled: true,
      before,
      after: atLimit,
      env: {
        ARCHESTRA_AGENT_RUNTIME_TIERS: JSON.stringify([
          { name: "S", memory_limit_gib: 8, current: true },
          { name: "S-fast", memory_limit_gib: 8 },
          { name: "L", memory_limit_gib: 24 },
        ]),
      },
    });
    expect(sameMemory?.split("\n").at(-1)).toBe(
      "  - Or move the work to a larger tier: start a run of this agent at L, which has a memory limit of 24 GiB, and hand over the branch.",
    );
    const elsewhere = describeToolMemoryKill({
      ...typeCheck,
      subjectKilled: true,
      before,
      after: atLimit,
      env: {},
    });
    expect(elsewhere?.split("\n")[0]).toBe(
      "type-check: tsc was killed for memory: this container reached its memory limit of 8 GiB (peak usage 8 GiB).",
    );
    expect(elsewhere?.split("\n").at(-1)).toBe("  - Or give it more memory.");
  });

  test("says nothing when nothing was killed or the counters cannot be read", () => {
    expect(
      describeToolMemoryKill({
        ...typeCheck,
        subjectKilled: true,
        before,
        after: before,
      }),
    ).toBeNull();
    expect(
      describeToolMemoryKill({
        ...typeCheck,
        subjectKilled: true,
        before: null,
        after: atLimit,
      }),
    ).toBeNull();
  });
});
