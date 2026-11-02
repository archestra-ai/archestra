import {
  type AgentRuntimeTierSize,
  resolveAgentRuntimeTiers,
} from "@archestra/shared";
import { afterEach, describe, expect, test } from "vitest";
import config from "@/config";
import {
  agentRuntimeAllowedTiers,
  agentRuntimeMaxTier,
  agentRuntimeTier,
  describeScaleupDisabledPrompt,
  resolveAgentRunLimits,
  resolveRunResources,
  resolveRunWorkspaceStorageSize,
  retargetScaleupDisabledPrompt,
  retargetTierResourceEnv,
  runtimeSystemPrompt,
  runtimeTiersEnv,
  sizedToolchainEnv,
  tierResourceEnv,
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

  test("a size tells the run's tools its quantities, its whole CPUs and the toolchain thread counts", () => {
    // No CPU limit: the request, rounded up, is the parallelism.
    expect(
      tierResourceEnv({
        cpuRequest: "3500m",
        memoryRequest: "7Gi",
        memoryLimit: "14Gi",
      }),
    ).toEqual({
      pod: {
        ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "3500m",
        ARCHESTRA_AGENT_RUNTIME_POD_CPU_LIMIT: undefined,
        ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_REQUEST: "7Gi",
        ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT: "14Gi",
        ARCHESTRA_AGENT_RUNTIME_POD_CPUS: "4",
      },
      toolchain: {
        GOMAXPROCS: "4",
        CARGO_BUILD_JOBS: "4",
        RAYON_NUM_THREADS: "4",
      },
    });
    // A CPU limit caps it.
    expect(
      tierResourceEnv({ cpuRequest: "2", cpuLimit: "3" }).toolchain.GOMAXPROCS,
    ).toBe("3");
    // A size without CPU sets no thread counts.
    expect(tierResourceEnv({ memoryLimit: "8Gi" }).toolchain).toEqual({
      GOMAXPROCS: undefined,
      CARGO_BUILD_JOBS: undefined,
      RAYON_NUM_THREADS: undefined,
    });
    // A launch sets the thread counts the Agent's environment leaves unset,
    // and lists them.
    expect(
      sizedToolchainEnv({
        resources: { cpuRequest: "2" },
        agentEnvKeys: ["CARGO_BUILD_JOBS", "OTHER"],
      }),
    ).toEqual({
      GOMAXPROCS: "2",
      RAYON_NUM_THREADS: "2",
      ARCHESTRA_AGENT_RUNTIME_SIZED_ENV: "GOMAXPROCS,RAYON_NUM_THREADS",
    });
    // Served by a larger Pod: quantities follow it, a limit the served size
    // lacks goes, and only the listed thread counts move. The Agent's own
    // CARGO_BUILD_JOBS stays although it equals the requested size's default.
    expect(
      retargetTierResourceEnv({
        env: {
          ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "2",
          ARCHESTRA_AGENT_RUNTIME_POD_CPU_LIMIT: "2",
          ARCHESTRA_AGENT_RUNTIME_POD_CPUS: "2",
          ARCHESTRA_AGENT_RUNTIME_SIZED_ENV: "GOMAXPROCS,RAYON_NUM_THREADS",
          GOMAXPROCS: "2",
          RAYON_NUM_THREADS: "2",
          CARGO_BUILD_JOBS: "2",
          OTHER: "kept",
        },
        served: { cpuRequest: "4", memoryLimit: "16Gi" },
      }),
    ).toEqual({
      ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "4",
      ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT: "16Gi",
      ARCHESTRA_AGENT_RUNTIME_POD_CPUS: "4",
      ARCHESTRA_AGENT_RUNTIME_SIZED_ENV: "GOMAXPROCS,RAYON_NUM_THREADS",
      GOMAXPROCS: "4",
      RAYON_NUM_THREADS: "4",
      CARGO_BUILD_JOBS: "2",
      OTHER: "kept",
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
    // Without a scaleup tier the Agent's own tier is the ceiling. A run of
    // the Agent asking for more is told it cannot scale up; a caller outside
    // any run hears the tiers it may use.
    expect(agentRuntimeMaxTier({ ...DEFAULTS, tier: "S" }, TIERS)).toBe("S");
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, tier: "S" },
        tiers: TIERS,
        currentTier: "S",
        requested: { tier: "M" },
      }),
    ).toThrow(
      "Cannot scale up this agent runtime instance: scaling up is disabled and the runtime tier is fixed to S (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace). This call is not retriable; calling it again will fail.",
    );
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, tier: "S" },
        tiers: TIERS,
        requested: { tier: "M" },
      }),
    ).toThrow(
      "Tier M (4 CPU, 8 GiB (16 GiB limit), 20 GiB workspace) is above this Agent's scaleup tier S. Tiers this Agent's runs may use: S (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace).",
    );
    // When scaling up is allowed, requesting above the scaleup tier names the allowed tiers.
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, tier: "S", maxTier: "M" },
        tiers: TIERS,
        requested: { tier: "L" },
      }),
    ).toThrow(
      "Tier L (8 CPU, 16 GiB (32 GiB limit), 20 GiB workspace) is above this Agent's scaleup tier M. Tiers this Agent's runs may use: S (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace), M (4 CPU, 8 GiB (16 GiB limit), 20 GiB workspace).",
    );
    // A scaleup tier below the Agent's own tier counts as the Agent's tier.
    expect(
      agentRuntimeMaxTier({ ...DEFAULTS, tier: "M", maxTier: "S" }, TIERS),
    ).toBe("M");
    expect(
      describeScaleupDisabledPrompt({ ...DEFAULTS, tier: "S" }, TIERS),
    ).toBe(
      "Scaling up this agent runtime instance is disabled: the runtime tier is fixed to S (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace). You cannot scale up this instance; do not attempt to start a run at a larger tier.",
    );
    expect(
      describeScaleupDisabledPrompt(
        { ...DEFAULTS, tier: "S", maxTier: "M" },
        TIERS,
      ),
    ).toBeNull();
    // A fixed M agent starting at S cannot scale up to M.
    const fixedM = { ...DEFAULTS, tier: "M", maxTier: "M" };
    expect(
      resolveAgentRunLimits({
        runtime: fixedM,
        tiers: TIERS,
        requested: { tier: "S" },
      }).tier,
    ).toBe("S");
    expect(() =>
      resolveAgentRunLimits({
        runtime: fixedM,
        tiers: TIERS,
        currentTier: "S",
        requested: { tier: "M" },
      }),
    ).toThrow(
      "Cannot scale up this agent runtime instance: scaling up is disabled and the runtime tier is fixed to S (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace). This call is not retriable; calling it again will fail.",
    );
    expect(() =>
      resolveAgentRunLimits({
        runtime: fixedM,
        tiers: TIERS,
        currentTier: "S",
        requested: { minCpu: 4 },
      }),
    ).toThrow(
      "Cannot scale up this agent runtime instance: scaling up is disabled and the runtime tier is fixed to S (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace). This call is not retriable; calling it again will fail.",
    );
    // The prompt uses the resolved run tier for fixed-tier runs.
    expect(describeScaleupDisabledPrompt(fixedM, TIERS, "S")).toBe(
      "Scaling up this agent runtime instance is disabled: the runtime tier is fixed to S (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace). You cannot scale up this instance; do not attempt to start a run at a larger tier.",
    );
    // When scaling is enabled, an omitted-size request from an L caller uses the Agent's default M.
    const scalingWorker = { ...DEFAULTS, tier: "M", maxTier: "L" };
    expect(
      resolveAgentRunLimits({
        runtime: scalingWorker,
        tiers: TIERS,
        currentTier: "L",
        requested: {},
      }).tier,
    ).toBe("M");
    expect(
      resolveAgentRunLimits({
        runtime: scalingWorker,
        tiers: TIERS,
        currentTier: "L",
        requested: { maxDurationHours: 2 },
      }).tier,
    ).toBe("M");
    // When an administrator reduces the Agent to S, an active M caller requesting without limits gets S.
    const reducedToS = { ...DEFAULTS, tier: "S", maxTier: "S" };
    expect(
      resolveAgentRunLimits({
        runtime: reducedToS,
        tiers: TIERS,
        currentTier: "M",
        requested: {},
      }).tier,
    ).toBe("S");
    // A name the organization has no tier for.
    expect(() =>
      resolveAgentRunLimits({
        runtime: worker,
        tiers: TIERS,
        requested: { tier: "XL" },
      }),
    ).toThrow("There is no tier named XL.");
  });

  test("a caller outside any run gets refusals that code-review-action retries at the Agent's own size", () => {
    // code-review-action starts a review with a size request (a CPU or
    // memory floor, a shorter duration) and, when the Agent refuses it,
    // starts the run again without one. It recognizes the
    // refusal by this wording (src/archestra/client.ts, `refusedLimits`); a
    // refusal it does not recognize fails every review on that Agent.
    const RETRIED_AT_OWN_SIZE =
      /is above this Agent's|sizes its runs with explicit resources|No tier this Agent's runs may use|There is no tier named|has less than the/i;
    const fixedS = { ...DEFAULTS, tier: "S", maxTier: "S" };
    const refusal = (requested: {
      tier?: string;
      minCpu?: number;
      minMemoryGib?: number;
      maxDurationHours?: number;
    }) => {
      try {
        resolveAgentRunLimits({ runtime: fixedS, tiers: TIERS, requested });
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected a refusal");
    };
    for (const requested of [
      { minMemoryGib: 7 },
      { minCpu: 3 },
      { tier: "M" },
      { tier: "S", minMemoryGib: 7 },
      { maxDurationHours: 9999 },
    ]) {
      expect(refusal(requested)).toMatch(RETRIED_AT_OWN_SIZE);
      expect(refusal(requested)).not.toContain("not retriable");
    }
    // Without the request the same Agent starts at its own tier.
    expect(resolveAgentRunLimits({ runtime: fixedS, tiers: TIERS }).tier).toBe(
      "S",
    );
  });

  test("retargets fixed-tier system instruction to served tier", () => {
    const allowed = TIERS.tiers;
    const tiersEnv = runtimeTiersEnv(allowed, "S", 20);
    const originalPrompt =
      "System prompt header.\n\n" +
      "Scaling up this agent runtime instance is disabled: the runtime tier is fixed to S (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace). You cannot scale up this instance; do not attempt to start a run at a larger tier.\n\n" +
      "System prompt footer.";
    const retargeted = retargetScaleupDisabledPrompt(
      originalPrompt,
      tiersEnv,
      "M",
    );
    expect(retargeted).toBe(
      "System prompt header.\n\n" +
        "Scaling up this agent runtime instance is disabled: the runtime tier is fixed to M (4 CPU, 8 GiB (16 GiB limit), 20 GiB workspace). You cannot scale up this instance; do not attempt to start a run at a larger tier.\n\n" +
        "System prompt footer.",
    );
    // When prompt has no fixed-tier instruction, it is returned unchanged.
    expect(
      retargetScaleupDisabledPrompt("Standard prompt", tiersEnv, "M"),
    ).toBe("Standard prompt");
    // Does not interpret special replacement tokens like $& or $` in custom tier names
    const tokenTiers: AgentRuntimeTierSize[] = [
      {
        name: "M $&",
        cpuRequest: 4,
        cpuLimit: null,
        memoryRequestMiB: 8192,
        memoryLimitMiB: 16384,
        warmSpares: 0,
        pooled: false,
        workspaceGiB: null,
      },
    ];
    const tokenTiersEnv = runtimeTiersEnv(tokenTiers, "M $&", 20);
    const tokenRetargeted = retargetScaleupDisabledPrompt(
      originalPrompt,
      tokenTiersEnv,
      "M $&",
    );
    expect(tokenRetargeted).toBe(
      "System prompt header.\n\n" +
        "Scaling up this agent runtime instance is disabled: the runtime tier is fixed to M $& (4 CPU, 8 GiB (16 GiB limit), 20 GiB workspace). You cannot scale up this instance; do not attempt to start a run at a larger tier.\n\n" +
        "System prompt footer.",
    );
    // Retargets cleanly when tier name contains a period and the closing clause
    const clauseTierName =
      "M. You cannot scale up this instance; do not attempt to start a run at a larger tier.";
    const clauseTiers: AgentRuntimeTierSize[] = [
      {
        name: clauseTierName,
        cpuRequest: 2,
        cpuLimit: null,
        memoryRequestMiB: 4096,
        memoryLimitMiB: 8192,
        warmSpares: 0,
        pooled: false,
        workspaceGiB: null,
      },
      {
        name: "L",
        cpuRequest: 8,
        cpuLimit: null,
        memoryRequestMiB: 16384,
        memoryLimitMiB: 32768,
        warmSpares: 0,
        pooled: false,
        workspaceGiB: null,
      },
    ];
    const clausePrompt =
      "System prompt header.\n\n" +
      `Scaling up this agent runtime instance is disabled: the runtime tier is fixed to ${clauseTierName} (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace). You cannot scale up this instance; do not attempt to start a run at a larger tier.\n\n` +
      "System prompt footer.";
    const clauseTiersEnv = runtimeTiersEnv(clauseTiers, clauseTierName, 20);
    const clauseRetargeted = retargetScaleupDisabledPrompt(
      clausePrompt,
      clauseTiersEnv,
      "L",
    );
    expect(clauseRetargeted).toBe(
      "System prompt header.\n\n" +
        "Scaling up this agent runtime instance is disabled: the runtime tier is fixed to L (8 CPU, 16 GiB (32 GiB limit), 20 GiB workspace). You cannot scale up this instance; do not attempt to start a run at a larger tier.\n\n" +
        "System prompt footer.",
    );
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
    // When scaling up is disabled, a run asking for more size than the fixed
    // tier fails with a non-retriable error; a caller outside any run hears
    // the tiers it may use.
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, tier: "Small", maxTier: "Small" },
        tiers: CUSTOM,
        currentTier: "Small",
        requested: { minCpu: 4 },
      }),
    ).toThrow(
      "Cannot scale up this agent runtime instance: scaling up is disabled and the runtime tier is fixed to Small (1 CPU, 2 GiB (4 GiB limit), 20 GiB workspace). This call is not retriable; calling it again will fail.",
    );
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, tier: "Small", maxTier: "Small" },
        tiers: CUSTOM,
        requested: { minCpu: 4 },
      }),
    ).toThrow(
      "No tier this Agent's runs may use has 4 CPU. Tiers this Agent's runs may use: Small (1 CPU, 2 GiB (4 GiB limit), 20 GiB workspace).",
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
    // Scaleup fixed at Tilt: the disk rule still keeps Small out, and a run
    // whose work needs more than Tilt meets the fixed-scaleup refusal, not
    // the disk message: only a larger tier would fit, and that is disabled.
    // A caller outside any run hears that no tier has the CPU.
    const fixedAtTilt = { ...DEFAULTS, tier: "Tilt", maxTier: "Tilt" };
    expect(
      resolveAgentRunLimits({
        runtime: fixedAtTilt,
        tiers,
        requested: { minCpu: 2 },
      }),
    ).toMatchObject({ tier: "Tilt", workspaceGiB: 60 });
    expect(() =>
      resolveAgentRunLimits({
        runtime: fixedAtTilt,
        tiers,
        currentTier: "Tilt",
        requested: { minCpu: 5 },
      }),
    ).toThrow(
      "Cannot scale up this agent runtime instance: scaling up is disabled and the runtime tier is fixed to Tilt (4 CPU, 8 GiB (16 GiB limit), 60 GiB workspace). This call is not retriable; calling it again will fail.",
    );
    expect(() =>
      resolveAgentRunLimits({
        runtime: fixedAtTilt,
        tiers,
        requested: { minCpu: 5 },
      }),
    ).toThrow(
      "No tier this Agent's runs may use has 5 CPU. Tiers this Agent's runs may use: Small (2 CPU, 4 GiB (8 GiB limit), 20 GiB workspace), Tilt (4 CPU, 8 GiB (16 GiB limit), 60 GiB workspace).",
    );
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
