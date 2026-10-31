import { describe, expect, test } from "vitest";
import {
  AgentRuntimeTierSettingsSchema,
  agentRuntimeTierMemory,
  agentRuntimeTierProblems,
  DEFAULT_AGENT_RUNTIME_TIERS,
  describeAgentRuntimeTier,
  nextLargerAgentRuntimeTier,
  parseCpuQuantity,
  resolveAgentRuntimeTiers,
  sortAgentRuntimeTiers,
} from "./agent-runtime-tiers";

const DEPLOYMENT = { defaultWarmSpares: 1 };

describe("resolveAgentRuntimeTiers", () => {
  test("gives the defaults, smallest first, when the organization saved nothing", () => {
    const resolved = resolveAgentRuntimeTiers(null, DEPLOYMENT);
    expect(resolved.defaultTier).toBe("M");
    expect(resolved.tiers).toEqual([
      {
        name: "S",
        cpuRequest: 2,
        cpuLimit: null,
        warmSpares: 1,
        pooled: true,
        memoryRequestMiB: 4096,
        memoryLimitMiB: 8192,
      },
      {
        name: "M",
        cpuRequest: 4,
        cpuLimit: null,
        warmSpares: 1,
        pooled: true,
        memoryRequestMiB: 8192,
        memoryLimitMiB: 16384,
      },
      {
        name: "L",
        cpuRequest: 8,
        cpuLimit: null,
        warmSpares: 0,
        pooled: false,
        memoryRequestMiB: 16384,
        memoryLimitMiB: 32768,
      },
    ]);
    // The defaults themselves are never mutated.
    expect(DEFAULT_AGENT_RUNTIME_TIERS.tiers[2].warmSpares).toBe(0);
  });

  test("reads a saved list, sorts it by size and keeps its default tier", () => {
    const resolved = resolveAgentRuntimeTiers(
      {
        tiers: [
          { name: "Large", cpuRequest: 6, cpuLimit: 8, warmSpares: 0 },
          { name: "Small", cpuRequest: 1, cpuLimit: null, warmSpares: 2 },
        ],
        defaultTier: "small",
      },
      DEPLOYMENT,
    );
    expect(resolved.tiers.map((tier) => tier.name)).toEqual(["Small", "Large"]);
    expect(resolved.defaultTier).toBe("Small");
    expect(resolved.tiers[1]).toMatchObject({
      cpuLimit: 8,
      memoryRequestMiB: 12288,
      memoryLimitMiB: 16384,
    });
  });

  test("reads the first saved shape: S, M and L with quantities, memory now following the CPU", () => {
    const resolved = resolveAgentRuntimeTiers(
      {
        L: {
          cpuRequest: "6",
          memoryRequest: "16Gi",
          memoryLimit: "32Gi",
          warmPoolSize: 1,
        },
        S: { cpuRequest: "500m", cpuLimit: null },
      },
      DEPLOYMENT,
    );
    expect(resolved.tiers).toEqual([
      {
        name: "S",
        cpuRequest: 0.5,
        cpuLimit: null,
        warmSpares: 1,
        pooled: true,
        memoryRequestMiB: 1024,
        memoryLimitMiB: 2048,
      },
      {
        name: "M",
        cpuRequest: 4,
        cpuLimit: null,
        warmSpares: 1,
        pooled: true,
        memoryRequestMiB: 8192,
        memoryLimitMiB: 16384,
      },
      {
        name: "L",
        cpuRequest: 6,
        cpuLimit: null,
        warmSpares: 1,
        pooled: true,
        memoryRequestMiB: 12288,
        memoryLimitMiB: 24576,
      },
    ]);
    expect(resolved.defaultTier).toBe("M");
  });

  test("falls back field by field on values that do not validate, and to the defaults on an empty list", () => {
    const resolved = resolveAgentRuntimeTiers(
      {
        tiers: [
          { name: "Odd", cpuRequest: 2, cpuLimit: 1, warmSpares: 99 },
          { name: "", cpuRequest: 3 },
        ],
        defaultTier: "gone",
      },
      DEPLOYMENT,
    );
    expect(resolved.tiers).toEqual([
      {
        name: "Odd",
        cpuRequest: 2,
        cpuLimit: null,
        warmSpares: 1,
        pooled: true,
        memoryRequestMiB: 4096,
        memoryLimitMiB: 8192,
      },
    ]);
    expect(resolved.defaultTier).toBe("Odd");
    expect(
      resolveAgentRuntimeTiers({ tiers: [] }, DEPLOYMENT).tiers.map(
        (tier) => tier.name,
      ),
    ).toEqual(["S", "M", "L"]);
  });
});

describe("sizes and order", () => {
  test("memory is 2 GiB per CPU, with a limit of twice the request or the CPU limit's share", () => {
    expect(agentRuntimeTierMemory(2, null)).toEqual({
      memoryRequestMiB: 4096,
      memoryLimitMiB: 8192,
    });
    expect(agentRuntimeTierMemory(2, 3)).toEqual({
      memoryRequestMiB: 4096,
      memoryLimitMiB: 6144,
    });
    expect(agentRuntimeTierMemory(2, 8)).toEqual({
      memoryRequestMiB: 4096,
      memoryLimitMiB: 8192,
    });
    expect(agentRuntimeTierMemory(0.25, null)).toEqual({
      memoryRequestMiB: 512,
      memoryLimitMiB: 1024,
    });
  });

  test("tiers sort by CPU request, then CPU limit with no limit last, then name; the next larger tier follows that order", () => {
    const tiers = resolveAgentRuntimeTiers(
      {
        tiers: [
          { name: "B", cpuRequest: 2, cpuLimit: null, warmSpares: 0 },
          { name: "A", cpuRequest: 2, cpuLimit: 3, warmSpares: 0 },
          { name: "C", cpuRequest: 1, cpuLimit: null, warmSpares: 0 },
          { name: "D", cpuRequest: 2, cpuLimit: null, warmSpares: 0 },
        ],
        defaultTier: "C",
      },
      DEPLOYMENT,
    ).tiers;
    expect(sortAgentRuntimeTiers(tiers).map((tier) => tier.name)).toEqual([
      "C",
      "A",
      "B",
      "D",
    ]);
    expect(nextLargerAgentRuntimeTier(tiers, "C")?.name).toBe("A");
    expect(nextLargerAgentRuntimeTier(tiers, "A")?.name).toBe("B");
    // B and D are the same size: neither is larger than the other.
    expect(nextLargerAgentRuntimeTier(tiers, "B")).toBeUndefined();
    expect(describeAgentRuntimeTier(tiers[1])).toBe(
      "2 CPU (3 limit), 4 GiB (6 GiB limit)",
    );
  });

  test("parses CPU quantities", () => {
    expect(parseCpuQuantity("2")).toBe(2);
    expect(parseCpuQuantity("500m")).toBe(0.5);
    expect(parseCpuQuantity("0.25")).toBe(0.25);
    expect(parseCpuQuantity("2 cores")).toBeNull();
  });
});

describe("AgentRuntimeTierSettingsSchema", () => {
  test("accepts a list with a default and refuses values out of range", () => {
    expect(
      AgentRuntimeTierSettingsSchema.safeParse({
        tiers: [
          {
            name: "S",
            cpuRequest: 0.5,
            cpuLimit: null,
            pooled: false,
            previousName: "Small",
          },
        ],
        defaultTier: "S",
      }).success,
    ).toBe(true);
    for (const tiers of [
      [{ name: "S", cpuRequest: 9, cpuLimit: null, pooled: false }],
      [{ name: "S", cpuRequest: 2, cpuLimit: 17, pooled: false }],
      [{ name: "S", cpuRequest: 2, cpuLimit: null, pooled: "yes" }],
      [{ name: "S", cpuRequest: 2.0001, cpuLimit: null, pooled: false }],
      [{ name: "", cpuRequest: 2, cpuLimit: null, pooled: false }],
      [{ name: "S", cpuRequest: 2, cpuLimit: null, pooled: false, gpu: 1 }],
      [],
    ])
      expect(
        AgentRuntimeTierSettingsSchema.safeParse({ tiers, defaultTier: "S" })
          .success,
      ).toBe(false);
  });
});

describe("agentRuntimeTierProblems", () => {
  test("has none for the defaults", () => {
    expect(agentRuntimeTierProblems(DEFAULT_AGENT_RUNTIME_TIERS)).toEqual([]);
  });

  test("names a repeated or missing name, a limit below its request, values out of range and a missing default", () => {
    expect(
      agentRuntimeTierProblems({
        tiers: [
          { name: "S", cpuRequest: 2, cpuLimit: 1 },
          { name: "s", cpuRequest: 9, cpuLimit: null },
          { name: " ", cpuRequest: 1, cpuLimit: 20 },
        ],
        defaultTier: "M",
      }),
    ).toEqual([
      "Tier S: the CPU limit is below the CPU request",
      "Two tiers are named s",
      "Tier s: the CPU request is more than 0 and at most 8",
      "Name every tier",
      "A tier without a name: the CPU limit is more than 0 and at most 16",
      "The default tier M is not in the list",
    ]);
  });
});
