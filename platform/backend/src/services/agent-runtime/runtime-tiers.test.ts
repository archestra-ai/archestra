import { resolveAgentRuntimeTiers } from "@archestra/shared";
import { afterEach, describe, expect, test } from "vitest";
import config from "@/config";
import {
  agentRuntimeAllowedTiers,
  agentRuntimeMaxTier,
  agentRuntimeTier,
  resolveAgentRunLimits,
  resolveRunResources,
  resolveRunWorkspaceStorageSize,
  runtimeSystemPrompt,
  runtimeTiersEnv,
  warmPoolReplicas,
  warmTierCandidates,
} from "./runtime-tiers";

const DEFAULTS = {
  tier: null,
  idleTimeoutMinutes: null,
  ttlHours: null,
  maxCostUsd: null,
};
/** The default tiers of an organization that saved none; two spares per tier by default. */
const TIERS = resolveAgentRuntimeTiers(null, { defaultWarmSpares: 2 });
/** An organization's own list: four tiers with their own names, XL with a CPU limit. */
const CUSTOM = resolveAgentRuntimeTiers(
  {
    tiers: [
      { name: "Small", cpuRequest: 1, cpuLimit: null, warmSpares: 1 },
      { name: "Medium", cpuRequest: 3, cpuLimit: null, warmSpares: 1 },
      { name: "Large", cpuRequest: 6, cpuLimit: null, warmSpares: 0 },
      { name: "XL", cpuRequest: 8, cpuLimit: 12, warmSpares: 0 },
    ],
    defaultTier: "Medium",
  },
  { defaultWarmSpares: 2 },
);

describe("runtime tiers", () => {
  test("an Agent without a tier runs at the organization's default; a run gets its tier's size", () => {
    expect(agentRuntimeTier(DEFAULTS, TIERS)).toBe("M");
    expect(agentRuntimeTier({ tier: "L" }, TIERS)).toBe("L");
    expect(agentRuntimeTier({ tier: "l" }, TIERS)).toBe("L");
    expect(agentRuntimeTier(DEFAULTS, CUSTOM)).toBe("Medium");
    // A tier the organization no longer has reads as the default.
    expect(agentRuntimeTier({ tier: "XXL" }, CUSTOM)).toBe("Medium");
    expect(resolveRunResources("S", TIERS)).toEqual({
      cpuRequest: "2",
      memoryRequest: "4Gi",
      memoryLimit: "8Gi",
    });
    expect(resolveRunResources(null, TIERS)).toEqual({
      cpuRequest: "4",
      memoryRequest: "8Gi",
      memoryLimit: "16Gi",
    });
  });

  test("memory follows the CPU: 2 GiB per CPU, a limit of twice that or the CPU limit's share", () => {
    expect(resolveRunResources("XL", CUSTOM)).toEqual({
      cpuRequest: "8",
      cpuLimit: "12",
      memoryRequest: "16Gi",
      memoryLimit: "24Gi",
    });
    const half = resolveAgentRuntimeTiers(
      {
        tiers: [
          { name: "Tiny", cpuRequest: 0.5, cpuLimit: 0.75, warmSpares: 0 },
        ],
        defaultTier: "Tiny",
      },
      { defaultWarmSpares: 0 },
    );
    expect(resolveRunResources("Tiny", half)).toEqual({
      cpuRequest: "500m",
      cpuLimit: "750m",
      memoryRequest: "1Gi",
      memoryLimit: "1536Mi",
    });
  });

  test("a run may ask for any tier up to the Agent's scaleup tier, which never falls below the default tier", () => {
    // A lite worker: runs start at M, and a run can move its work to S or L.
    const worker = { ...DEFAULTS, tier: "M", maxTier: "L" };
    expect(agentRuntimeMaxTier(worker, TIERS)).toBe("L");
    expect(
      agentRuntimeAllowedTiers(worker, TIERS).map((tier) => tier.name),
    ).toEqual(["S", "M", "L"]);
    expect(resolveAgentRunLimits({ runtime: worker, tiers: TIERS }).tier).toBe(
      "M",
    );
    expect(
      resolveAgentRunLimits({
        runtime: worker,
        tiers: TIERS,
        requested: { tier: "L" },
      }).tier,
    ).toBe("L");
    expect(
      resolveAgentRunLimits({
        runtime: worker,
        tiers: TIERS,
        requested: { tier: "s" },
      }).tier,
    ).toBe("S");
    // Without a scaleup tier the Agent's own tier is the ceiling.
    expect(agentRuntimeMaxTier({ ...DEFAULTS, tier: "S" }, TIERS)).toBe("S");
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, tier: "S" },
        tiers: TIERS,
        requested: { tier: "M" },
      }),
    ).toThrow(
      "Tier M (4 CPU, 8 GiB (16 GiB limit), 20 GiB workspace) is above this Agent's scaleup tier S. Tiers this Agent's runs may use: S (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace).",
    );
    // A scaleup tier below the Agent's own tier counts as the Agent's tier.
    expect(
      agentRuntimeMaxTier({ ...DEFAULTS, tier: "M", maxTier: "S" }, TIERS),
    ).toBe("M");
    // A name the organization has no tier for.
    expect(() =>
      resolveAgentRunLimits({
        runtime: worker,
        tiers: TIERS,
        requested: { tier: "XL" },
      }),
    ).toThrow("There is no tier named XL.");
  });

  test("a run may ask by size: the smallest allowed tier with that much CPU and memory", () => {
    const worker = { ...DEFAULTS, tier: "Medium", maxTier: "XL" };
    expect(
      resolveAgentRunLimits({
        runtime: worker,
        tiers: CUSTOM,
        requested: { minCpu: 4 },
      }).tier,
    ).toBe("Large");
    expect(
      resolveAgentRunLimits({
        runtime: worker,
        tiers: CUSTOM,
        requested: { minMemoryGib: 14 },
      }).tier,
    ).toBe("XL");
    // Less than the default tier gives the smallest tier that fits, not the default.
    expect(
      resolveAgentRunLimits({
        runtime: worker,
        tiers: CUSTOM,
        requested: { minCpu: 1 },
      }).tier,
    ).toBe("Small");
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, tier: "Small", maxTier: "Medium" },
        tiers: CUSTOM,
        requested: { minCpu: 4 },
      }),
    ).toThrow(
      "No tier this Agent's runs may use has 4 CPU. Tiers this Agent's runs may use: Small (1 CPU, 2 GiB (4 GiB limit), 20 GiB workspace), Medium (3 CPU, 6 GiB (12 GiB limit), 20 GiB workspace).",
    );
    // A named tier must also have the size asked for.
    expect(() =>
      resolveAgentRunLimits({
        runtime: worker,
        tiers: CUSTOM,
        requested: { tier: "Small", minCpu: 2 },
      }),
    ).toThrow(
      "Tier Small (1 CPU, 2 GiB (4 GiB limit), 20 GiB workspace) has less than the 2 CPU asked for.",
    );
  });

  test("a warm Sandbox may come from the requested tier, then the next larger one within the Agent's, never a smaller one", () => {
    const names = (tiers: { name: string }[]) => tiers.map((tier) => tier.name);
    expect(names(warmTierCandidates("S", "L", TIERS))).toEqual(["S", "M"]);
    expect(names(warmTierCandidates("M", "L", TIERS))).toEqual(["M", "L"]);
    expect(names(warmTierCandidates("M", "M", TIERS))).toEqual(["M"]);
    expect(names(warmTierCandidates("L", "L", TIERS))).toEqual(["L"]);
    expect(names(warmTierCandidates("Small", "XL", CUSTOM))).toEqual([
      "Small",
      "Medium",
    ]);
    expect(names(warmTierCandidates("Large", "XL", CUSTOM))).toEqual([
      "Large",
      "XL",
    ]);
    // A larger tier never serves a run whose workspace volume it cannot hold.
    const volumes = (bigWorkspaceGiB: number | null) =>
      resolveAgentRuntimeTiers(
        {
          tiers: [
            {
              name: "Tilt",
              cpuRequest: 6,
              cpuLimit: null,
              warmSpares: 0,
              workspaceGiB: 60,
            },
            {
              name: "Big",
              cpuRequest: 8,
              cpuLimit: null,
              warmSpares: 0,
              workspaceGiB: bigWorkspaceGiB,
            },
          ],
          defaultTier: "Tilt",
        },
        { defaultWarmSpares: 0 },
      );
    expect(names(warmTierCandidates("Tilt", "Big", volumes(null)))).toEqual([
      "Tilt",
    ]);
    expect(names(warmTierCandidates("Tilt", "Big", volumes(60)))).toEqual([
      "Tilt",
      "Big",
    ]);
  });

  test("a run's workspace volume is its tier's size, else the deployment's", () => {
    const sized = resolveAgentRuntimeTiers(
      {
        tiers: [
          { name: "Lite", cpuRequest: 2, cpuLimit: null, warmSpares: 0 },
          {
            name: "Tilt",
            cpuRequest: 6,
            cpuLimit: null,
            warmSpares: 0,
            workspaceGiB: 60,
          },
        ],
        defaultTier: "Lite",
      },
      { defaultWarmSpares: 2 },
    );
    expect(resolveRunWorkspaceStorageSize("Tilt", sized)).toBe("60Gi");
    expect(resolveRunWorkspaceStorageSize("Lite", sized)).toBe(
      config.agentRuntime.workspaceStorageSize,
    );
    // A tier the organization no longer has reads as the default tier.
    expect(resolveRunWorkspaceStorageSize("Gone", sized)).toBe(
      config.agentRuntime.workspaceStorageSize,
    );
    const sizes = (current: number | undefined) =>
      JSON.parse(runtimeTiersEnv(sized.tiers, "Tilt", current)).map(
        (tier: { name: string; workspace_gib?: number }) => [
          tier.name,
          tier.workspace_gib,
        ],
      );
    expect(sizes(60)).toEqual([
      ["Lite", 20],
      ["Tilt", 60],
    ]);
    // The run's own tier carries the volume the run has, which a continuation
    // keeps from its first turn, and nothing when that is unknown.
    expect(sizes(40)).toEqual([
      ["Lite", 20],
      ["Tilt", 40],
    ]);
    expect(sizes(undefined)).toEqual([
      ["Lite", 20],
      ["Tilt", undefined],
    ]);
  });

  test("the prompt names the run's volume between its fixed parts, and nothing when the size is unknown", () => {
    const parts = {
      beforeVolume: "Files persist.",
      afterVolume: " Ports: none.",
    };
    expect(runtimeSystemPrompt(parts, 60)).toBe(
      "Files persist. The workspace volume is 60 GiB in all, including any Docker data. Ports: none.",
    );
    expect(runtimeSystemPrompt(parts, undefined)).toBe(
      "Files persist. Ports: none.",
    );
  });

  test("a tier chosen by size never has a smaller workspace than the Agent's default tier", () => {
    const tiers = resolveAgentRuntimeTiers(
      {
        tiers: [
          { name: "Small", cpuRequest: 2, cpuLimit: null, warmSpares: 0 },
          {
            name: "Tilt",
            cpuRequest: 4,
            cpuLimit: null,
            warmSpares: 0,
            workspaceGiB: 60,
          },
          { name: "Big", cpuRequest: 6, cpuLimit: null, warmSpares: 0 },
          {
            name: "Huge",
            cpuRequest: 8,
            cpuLimit: null,
            warmSpares: 0,
            workspaceGiB: 80,
          },
        ],
        defaultTier: "Tilt",
      },
      { defaultWarmSpares: 0 },
    );
    const tilt = { ...DEFAULTS, tier: "Tilt", maxTier: "Huge" };
    // Small and Big have the CPU but only the deployment's 20 GiB.
    expect(
      resolveAgentRunLimits({
        runtime: tilt,
        tiers,
        requested: { minCpu: 2 },
      }),
    ).toMatchObject({ tier: "Tilt", workspaceGiB: 60 });
    expect(
      resolveAgentRunLimits({
        runtime: tilt,
        tiers,
        requested: { minCpu: 5 },
      }),
    ).toMatchObject({ tier: "Huge", workspaceGiB: 80 });
    // An Agent whose default tier has the deployment's size may get any.
    expect(
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, tier: "Small", maxTier: "Huge" },
        tiers,
        requested: { minCpu: 5 },
      }),
    ).toMatchObject({ tier: "Big", workspaceGiB: 20 });
    // No tier with the CPU and the disk: the refusal says which is missing.
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...tilt, maxTier: "Big" },
        tiers,
        requested: { minCpu: 5 },
      }),
    ).toThrow(
      "No tier this Agent's runs may use has 5 CPU and a workspace of at least 60 GiB, the size of its default tier.",
    );
  });

  test("the Pod reads the tiers it may move to, smallest first, with their sizes", () => {
    const worker = { ...DEFAULTS, tier: "Medium", maxTier: "Large" };
    expect(
      JSON.parse(
        runtimeTiersEnv(agentRuntimeAllowedTiers(worker, CUSTOM), "Medium", 20),
      ),
    ).toEqual([
      {
        name: "Small",
        cpu: 1,
        cpu_limit: null,
        memory_gib: 2,
        memory_limit_gib: 4,
        workspace_gib: 20,
      },
      {
        name: "Medium",
        cpu: 3,
        cpu_limit: null,
        memory_gib: 6,
        memory_limit_gib: 12,
        workspace_gib: 20,
        current: true,
      },
      {
        name: "Large",
        cpu: 6,
        cpu_limit: null,
        memory_gib: 12,
        memory_limit_gib: 24,
        workspace_gib: 20,
      },
    ]);
  });

  describe("warm spares per pool", () => {
    const warmPoolSize = config.agentRuntime.warmPoolSize;
    afterEach(() => {
      config.agentRuntime.warmPoolSize = warmPoolSize;
    });

    test("a tier keeps its own count; the defaults follow the deployment except L; none while pools are off", () => {
      config.agentRuntime.warmPoolSize = 2;
      expect(warmPoolReplicas(TIERS, "S")).toBe(2);
      expect(warmPoolReplicas(TIERS, "M")).toBe(2);
      expect(warmPoolReplicas(TIERS, "L")).toBe(0);
      expect(warmPoolReplicas(CUSTOM, "Small")).toBe(1);
      expect(warmPoolReplicas(CUSTOM, "Large")).toBe(0);
      config.agentRuntime.warmPoolSize = 0;
      expect(warmPoolReplicas(CUSTOM, "Small")).toBe(0);
    });
  });

  test("a run takes the Agent's limits, else the deployment defaults", () => {
    expect(resolveAgentRunLimits({ runtime: DEFAULTS, tiers: TIERS })).toEqual({
      tier: "M",
      idleTimeoutMinutes: config.agentRuntime.defaultIdleTimeoutMinutes,
      maxDurationHours: config.agentRuntime.defaultTtlHours,
      maxCostUsd: null,
      workspaceGiB: 20,
    });
    expect(
      resolveAgentRunLimits({
        runtime: {
          ...DEFAULTS,
          tier: "L",
          idleTimeoutMinutes: 30,
          ttlHours: 48,
          maxCostUsd: 25,
        },
        tiers: TIERS,
      }),
    ).toEqual({
      tier: "L",
      idleTimeoutMinutes: 30,
      maxDurationHours: 48,
      maxCostUsd: 25,
      workspaceGiB: 20,
    });
  });

  test("a caller may ask for less than the Agent allows, never more", () => {
    const runtime = {
      ...DEFAULTS,
      tier: "L",
      idleTimeoutMinutes: 30,
      ttlHours: 48,
      maxCostUsd: 25,
    };
    expect(
      resolveAgentRunLimits({
        runtime,
        tiers: TIERS,
        requested: {
          tier: "S",
          idleTimeoutMinutes: 10,
          maxDurationHours: 3,
          maxCostUsd: 5,
        },
      }),
    ).toEqual({
      tier: "S",
      idleTimeoutMinutes: 10,
      maxDurationHours: 3,
      maxCostUsd: 5,
      workspaceGiB: 20,
    });
    for (const [requested, message] of [
      [
        { idleTimeoutMinutes: 31 },
        "idle timeout of 31 minutes is above this Agent's 30",
      ],
      [
        { maxDurationHours: 49 },
        "maximum duration of 49 hours is above this Agent's 48",
      ],
      [{ maxCostUsd: 26 }, "budget of 26 USD is above this Agent's 25"],
    ] as const) {
      expect(() =>
        resolveAgentRunLimits({ runtime, tiers: TIERS, requested }),
      ).toThrow(message);
    }
    // Without a budget on the Agent, any budget bounds the run.
    expect(
      resolveAgentRunLimits({
        runtime: DEFAULTS,
        tiers: TIERS,
        requested: { maxCostUsd: 3 },
      }).maxCostUsd,
    ).toBe(3);
  });
});
