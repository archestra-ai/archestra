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
  summarizeAgentRuntimeTier,
} from "./agent-runtime-tiers";

const DEPLOYMENT = { defaultWarmSpares: 1 };

describe("resolveAgentRuntimeTiers", () => {
  test("resolves independent memory overrides and keeps CPU-derived defaults for omitted fields", () => {
    const resolved = resolveAgentRuntimeTiers(
      {
        tiers: [
          {
            name: "Memory",
            cpuRequest: 0.5,
            cpuLimit: 0.5,
            memoryRequestMiB: 8192,
            memoryLimitMiB: 8192,
          },
          { name: "Limit", cpuRequest: 1, memoryLimitMiB: 8192 },
          { name: "Request", cpuRequest: 1, memoryRequestMiB: 1536 },
          {
            name: "Invalid",
            cpuRequest: 1,
            memoryRequestMiB: 8192,
            memoryLimitMiB: 1024,
          },
          {
            name: "Malformed",
            cpuRequest: 1,
            memoryRequestMiB: -1,
            memoryLimitMiB: 1.5,
          },
          {
            name: "Unrepresentable",
            cpuRequest: 1,
            memoryRequestMiB: 2 ** 52,
          },
        ],
        defaultTier: "Memory",
      },
      DEPLOYMENT,
    );
    expect(resolved.tiers.find((tier) => tier.name === "Memory")).toMatchObject(
      {
        cpuRequest: 0.5,
        memoryRequestMiB: 8192,
        memoryLimitMiB: 8192,
        memoryRequestMiBOverride: 8192,
        memoryLimitMiBOverride: 8192,
      },
    );
    expect(resolved.tiers.find((tier) => tier.name === "Limit")).toMatchObject({
      memoryRequestMiB: 2048,
      memoryLimitMiB: 8192,
    });
    expect(
      resolved.tiers.find((tier) => tier.name === "Request"),
    ).toMatchObject({
      memoryRequestMiB: 1536,
      memoryLimitMiB: 3072,
    });
    for (const name of ["Invalid", "Malformed", "Unrepresentable"]) {
      expect(resolved.tiers.find((tier) => tier.name === name)).toMatchObject({
        memoryRequestMiB: 2048,
        memoryLimitMiB: 4096,
      });
      expect(
        resolved.tiers.find((tier) => tier.name === name),
      ).not.toHaveProperty("memoryRequestMiBOverride");
    }
  });
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
        workspaceGiB: null,
      },
      {
        name: "M",
        cpuRequest: 4,
        cpuLimit: null,
        warmSpares: 1,
        pooled: true,
        memoryRequestMiB: 8192,
        memoryLimitMiB: 16384,
        workspaceGiB: null,
      },
      {
        name: "L",
        cpuRequest: 8,
        cpuLimit: null,
        warmSpares: 0,
        pooled: false,
        memoryRequestMiB: 16384,
        memoryLimitMiB: 32768,
        workspaceGiB: null,
      },
    ]);
    // The defaults themselves are never mutated.
    expect(DEFAULT_AGENT_RUNTIME_TIERS.tiers[2].warmSpares).toBe(0);
  });

  test("reads a saved list, sorts it by size and keeps its default tier", () => {
    const resolved = resolveAgentRuntimeTiers(
      {
        tiers: [
          {
            name: "Large",
            cpuRequest: 6,
            cpuLimit: 8,
            warmSpares: 0,
            workspaceGiB: 60,
          },
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
      memoryLimitMiB: 24576,
      workspaceGiB: 60,
    });
    // A tier that sets no size follows the deployment's default.
    expect(resolved.tiers[0].workspaceGiB).toBeNull();
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
        workspaceGiB: null,
      },
      {
        name: "M",
        cpuRequest: 4,
        cpuLimit: null,
        warmSpares: 1,
        pooled: true,
        memoryRequestMiB: 8192,
        memoryLimitMiB: 16384,
        workspaceGiB: null,
      },
      {
        name: "L",
        cpuRequest: 6,
        cpuLimit: null,
        warmSpares: 1,
        pooled: true,
        memoryRequestMiB: 12288,
        memoryLimitMiB: 24576,
        workspaceGiB: null,
      },
    ]);
    expect(resolved.defaultTier).toBe("M");
  });

  test("falls back field by field on values that do not validate, and to the defaults on an empty list", () => {
    const resolved = resolveAgentRuntimeTiers(
      {
        tiers: [
          {
            name: "Odd",
            cpuRequest: 2,
            cpuLimit: 1,
            warmSpares: 99,
            workspaceGiB: 1.5,
          },
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
        workspaceGiB: null,
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
  test("orders and upgrades tiers that differ only by their memory limit", () => {
    const tiers = resolveAgentRuntimeTiers(
      {
        tiers: [
          {
            name: "Higher",
            cpuRequest: 1,
            memoryRequestMiB: 1024,
            memoryLimitMiB: 4096,
          },
          {
            name: "Lower",
            cpuRequest: 1,
            memoryRequestMiB: 1024,
            memoryLimitMiB: 2048,
          },
        ],
        defaultTier: "Lower",
      },
      DEPLOYMENT,
    ).tiers;
    expect(tiers.map((tier) => tier.name)).toEqual(["Lower", "Higher"]);
    expect(nextLargerAgentRuntimeTier(tiers, "Lower")?.name).toBe("Higher");
    expect(nextLargerAgentRuntimeTier(tiers, "Higher")).toBeUndefined();
  });

  test("orders memory-only sizes and never upgrades to less memory or CPU", () => {
    const tiers = resolveAgentRuntimeTiers(
      {
        tiers: [
          {
            name: "Small",
            cpuRequest: 0.5,
            memoryRequestMiB: 4096,
            memoryLimitMiB: 4096,
          },
          {
            name: "Memory",
            cpuRequest: 0.5,
            memoryRequestMiB: 8192,
            memoryLimitMiB: 8192,
          },
          {
            name: "CPU",
            cpuRequest: 2,
            memoryRequestMiB: 4096,
            memoryLimitMiB: 4096,
          },
          {
            name: "Both",
            cpuRequest: 2,
            memoryRequestMiB: 8192,
            memoryLimitMiB: 8192,
          },
        ],
        defaultTier: "Small",
      },
      DEPLOYMENT,
    ).tiers;
    expect(tiers.map((tier) => tier.name)).toEqual([
      "Small",
      "Memory",
      "CPU",
      "Both",
    ]);
    expect(nextLargerAgentRuntimeTier(tiers, "Small")?.name).toBe("Memory");
    expect(nextLargerAgentRuntimeTier(tiers, "Memory")?.name).toBe("Both");
    expect(nextLargerAgentRuntimeTier(tiers, "Both")).toBeUndefined();
  });
  test("defaults the limit to the maximum of twice memory request, CPU request and CPU limit", () => {
    expect(agentRuntimeTierMemory({ cpuRequest: 2, cpuLimit: null })).toEqual({
      memoryRequestMiB: 4096,
      memoryLimitMiB: 8192,
    });
    expect(agentRuntimeTierMemory({ cpuRequest: 2, cpuLimit: 3 })).toEqual({
      memoryRequestMiB: 4096,
      memoryLimitMiB: 8192,
    });
    expect(agentRuntimeTierMemory({ cpuRequest: 2, cpuLimit: 8 })).toEqual({
      memoryRequestMiB: 4096,
      memoryLimitMiB: 16384,
    });
    expect(
      agentRuntimeTierMemory({ cpuRequest: 0.25, cpuLimit: null }),
    ).toEqual({
      memoryRequestMiB: 512,
      memoryLimitMiB: 1024,
    });
    expect(
      agentRuntimeTierMemory({
        cpuRequest: 4,
        cpuLimit: 10,
        memoryRequestMiB: 12288,
      }),
    ).toEqual({
      memoryRequestMiB: 12288,
      memoryLimitMiB: 24576,
    });
    expect(
      agentRuntimeTierMemory({
        cpuRequest: 4,
        cpuLimit: null,
        memoryRequestMiB: 1024,
      }),
    ).toEqual({
      memoryRequestMiB: 1024,
      memoryLimitMiB: 8192,
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
      "2 CPU (3 limit), 4 GiB (8 GiB limit)",
    );
    expect(describeAgentRuntimeTier({ ...tiers[1], workspaceGiB: 60 })).toBe(
      "2 CPU (3 limit), 4 GiB (8 GiB limit), 60 GiB workspace",
    );
    // The short label names every tier's effective workspace: its own size,
    // else the deployment's default.
    expect(summarizeAgentRuntimeTier(tiers[1], 20)).toBe(
      "2 CPU, 4 GiB, 20 GiB workspace",
    );
    expect(
      summarizeAgentRuntimeTier({ ...tiers[1], workspaceGiB: 60 }, 20),
    ).toBe("2 CPU, 4 GiB, 60 GiB workspace");
    // Without a known default it leaves the size out rather than guess.
    expect(summarizeAgentRuntimeTier(tiers[1])).toBe("2 CPU, 4 GiB");
    // With the deployment's default given, every tier names its volume.
    expect(describeAgentRuntimeTier(tiers[1], 20)).toBe(
      "2 CPU (3 limit), 4 GiB (8 GiB limit), 20 GiB workspace",
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
  test("accepts CPU boundaries and decimal values without floating-point rejection", () => {
    for (const cpuRequest of [0.1, 1.001, 8, 256]) {
      const settings = {
        tiers: [
          {
            name: "CPU",
            cpuRequest,
            cpuLimit: 256,
            pooled: false,
            workspaceGiB: null,
          },
        ],
        defaultTier: "CPU",
      };
      expect(AgentRuntimeTierSettingsSchema.safeParse(settings).success).toBe(
        true,
      );
      expect(agentRuntimeTierProblems(settings)).toEqual([]);
    }
  });
  test.each([
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid memory %s", (amount) => {
    for (const field of ["memoryRequestMiB", "memoryLimitMiB"]) {
      expect(
        AgentRuntimeTierSettingsSchema.safeParse({
          tiers: [
            {
              name: "Memory",
              cpuRequest: 0.5,
              cpuLimit: null,
              pooled: false,
              [field]: amount,
            },
          ],
          defaultTier: "Memory",
        }).success,
      ).toBe(false);
    }
  });
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
            workspaceGiB: 60,
          },
        ],
        defaultTier: "S",
      }).success,
    ).toBe(true);
    // Left out, the workspace size stays unset: the save keeps the tier's
    // current size rather than erasing it.
    expect(
      AgentRuntimeTierSettingsSchema.parse({
        tiers: [{ name: "S", cpuRequest: 1, cpuLimit: null, pooled: false }],
        defaultTier: "S",
      }).tiers[0],
    ).not.toHaveProperty("workspaceGiB");
    for (const tiers of [
      [{ name: "S", cpuRequest: 0.099, cpuLimit: null, pooled: false }],
      [{ name: "S", cpuRequest: 0.1, cpuLimit: 0.099, pooled: false }],
      [{ name: "S", cpuRequest: 257, cpuLimit: null, pooled: false }],
      [{ name: "S", cpuRequest: 2, cpuLimit: 257, pooled: false }],
      [{ name: "S", cpuRequest: 2, cpuLimit: null, pooled: "yes" }],
      [{ name: "S", cpuRequest: 2.0001, cpuLimit: null, pooled: false }],
      [{ name: "", cpuRequest: 2, cpuLimit: null, pooled: false }],
      [{ name: "S", cpuRequest: 2, cpuLimit: null, pooled: false, gpu: 1 }],
      [
        {
          name: "S",
          cpuRequest: 2,
          cpuLimit: null,
          pooled: false,
          workspaceGiB: 0,
        },
      ],
      [
        {
          name: "S",
          cpuRequest: 2,
          cpuLimit: null,
          pooled: false,
          workspaceGiB: 1.5,
        },
      ],
      [
        {
          name: "S",
          cpuRequest: 2,
          cpuLimit: null,
          pooled: false,
          workspaceGiB: Number.POSITIVE_INFINITY,
        },
      ],
      [],
    ])
      expect(
        AgentRuntimeTierSettingsSchema.safeParse({ tiers, defaultTier: "S" })
          .success,
      ).toBe(false);
  });
});

describe("agentRuntimeTierProblems", () => {
  test("validates memory limits against requests after applying CPU-derived defaults", () => {
    const base = {
      name: "Memory",
      cpuRequest: 0.5,
      cpuLimit: null,
      workspaceGiB: null,
    };
    expect(
      agentRuntimeTierProblems({
        tiers: [{ ...base, memoryRequestMiB: 8192, memoryLimitMiB: 4096 }],
        defaultTier: "Memory",
      }),
    ).toContain("Tier Memory: the memory limit is below the memory request");
    expect(
      agentRuntimeTierProblems({
        tiers: [{ ...base, memoryRequestMiB: 8192, memoryLimitMiB: 8192 }],
        defaultTier: "Memory",
      }),
    ).toEqual([]);
    expect(
      agentRuntimeTierProblems({
        tiers: [{ ...base, memoryLimitMiB: 512 }],
        defaultTier: "Memory",
      }),
    ).toContain("Tier Memory: the memory limit is below the memory request");
  });
  test("requires an explicit limit when doubling a large request would exceed the API integer range", () => {
    const tier = {
      name: "Memory",
      cpuRequest: 1,
      cpuLimit: null,
      workspaceGiB: null,
      memoryRequestMiB: 2 ** 52,
    };
    expect(
      agentRuntimeTierProblems({ tiers: [tier], defaultTier: "Memory" }),
    ).toEqual([
      "Tier Memory: calculated memory exceeds the supported numeric range; set an explicit memory limit",
    ]);
    expect(
      agentRuntimeTierProblems({
        tiers: [{ ...tier, memoryLimitMiB: 2 ** 52 }],
        defaultTier: "Memory",
      }),
    ).toEqual([]);
  });
  test("has none for the defaults", () => {
    expect(agentRuntimeTierProblems(DEFAULT_AGENT_RUNTIME_TIERS)).toEqual([]);
  });

  test("names a repeated or missing name, a limit below its request, values out of range and a missing default", () => {
    expect(
      agentRuntimeTierProblems({
        tiers: [
          { name: "S", cpuRequest: 2, cpuLimit: 1, workspaceGiB: null },
          { name: "s", cpuRequest: 257, cpuLimit: null, workspaceGiB: null },
          { name: " ", cpuRequest: 1, cpuLimit: 257, workspaceGiB: null },
          { name: "W", cpuRequest: 1, cpuLimit: null, workspaceGiB: 1.5 },
        ],
        defaultTier: "M",
      }),
    ).toEqual([
      "Tier S: the CPU limit is below the CPU request",
      "Two tiers are named s",
      "Tier s: the CPU request is at least 0.1 and at most 256",
      "Name every tier",
      "A tier without a name: the CPU limit is at least 0.1 and at most 256",
      "Tier W: the workspace is a positive whole number of GiB",
      "The default tier M is not in the list",
    ]);
  });
});
