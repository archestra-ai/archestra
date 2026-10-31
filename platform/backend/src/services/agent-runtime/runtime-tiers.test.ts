import {
  DEFAULT_AGENT_RUNTIME_TIERS,
  resolveAgentRuntimeTiers,
} from "@archestra/shared";
import { afterEach, describe, expect, test } from "vitest";
import config from "@/config";
import {
  agentRuntimeMaxTier,
  agentRuntimeTier,
  resolveAgentRunLimits,
  resolveRunResources,
  warmPoolReplicas,
  warmTierCandidates,
} from "./runtime-tiers";

const DEFAULTS = {
  tier: null,
  idleTimeoutMinutes: null,
  ttlHours: null,
  maxCostUsd: null,
};

describe("runtime tiers", () => {
  test("an Agent without a tier runs at M; a run gets its tier's size", () => {
    expect(agentRuntimeTier(DEFAULTS)).toBe("M");
    expect(agentRuntimeTier({ tier: "L" })).toBe("L");
    const tiers = DEFAULT_AGENT_RUNTIME_TIERS;
    expect(resolveRunResources("S", tiers)).toEqual({
      cpuRequest: "2",
      memoryRequest: "4Gi",
      memoryLimit: "8Gi",
    });
    expect(resolveRunResources(null, tiers)).toEqual({
      cpuRequest: "4",
      memoryRequest: "8Gi",
      memoryLimit: "16Gi",
    });
  });

  test("a run gets its tier's size in the organization, CPU limit included when an administrator set one", () => {
    const tiers = resolveAgentRuntimeTiers({
      L: { cpuRequest: "12", cpuLimit: "16", memoryLimit: "48Gi" },
    });
    expect(resolveRunResources("L", tiers)).toEqual({
      cpuRequest: "12",
      cpuLimit: "16",
      memoryRequest: "16Gi",
      memoryLimit: "48Gi",
    });
  });

  test("a run may ask for any tier up to the Agent's largest tier, which never falls below the Agent's own", () => {
    // A lite worker: runs start at M, and a run can move its work to S or L.
    const worker = { ...DEFAULTS, tier: "M" as const, maxTier: "L" as const };
    expect(agentRuntimeMaxTier(worker)).toBe("L");
    expect(resolveAgentRunLimits({ runtime: worker }).tier).toBe("M");
    expect(
      resolveAgentRunLimits({ runtime: worker, requested: { tier: "L" } }).tier,
    ).toBe("L");
    expect(
      resolveAgentRunLimits({ runtime: worker, requested: { tier: "S" } }).tier,
    ).toBe("S");
    // Without a largest tier the Agent's own tier is the ceiling, as before.
    expect(agentRuntimeMaxTier({ ...DEFAULTS, tier: "S" })).toBe("S");
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, tier: "S" },
        requested: { tier: "M" },
      }),
    ).toThrow("Tier M is above this Agent's largest tier S");
    // A largest tier below the Agent's own tier counts as the Agent's tier.
    expect(agentRuntimeMaxTier({ ...DEFAULTS, tier: "M", maxTier: "S" })).toBe(
      "M",
    );
  });

  test("a warm Sandbox may come from the requested tier, then the larger neighbour within the Agent's, never a smaller one", () => {
    expect(warmTierCandidates("S", "L")).toEqual(["S", "M"]);
    expect(warmTierCandidates("M", "L")).toEqual(["M", "L"]);
    expect(warmTierCandidates("M", "M")).toEqual(["M"]);
    expect(warmTierCandidates("L", "L")).toEqual(["L"]);
    expect(warmTierCandidates("S", "S")).toEqual(["S"]);
  });

  describe("warm spares per pool", () => {
    const warmPoolSize = config.agentRuntime.warmPoolSize;
    afterEach(() => {
      config.agentRuntime.warmPoolSize = warmPoolSize;
    });

    test("L keeps none by default; S and M follow the deployment; a tier's own count wins", () => {
      config.agentRuntime.warmPoolSize = 2;
      const defaults = DEFAULT_AGENT_RUNTIME_TIERS;
      expect(warmPoolReplicas(defaults, "S")).toBe(2);
      expect(warmPoolReplicas(defaults, "M")).toBe(2);
      expect(warmPoolReplicas(defaults, "L")).toBe(0);
      const set = resolveAgentRuntimeTiers({
        L: { warmPoolSize: 1 },
        M: { warmPoolSize: 0 },
      });
      expect(warmPoolReplicas(set, "L")).toBe(1);
      expect(warmPoolReplicas(set, "M")).toBe(0);
      // Warm pools off: no tier keeps spares.
      config.agentRuntime.warmPoolSize = 0;
      expect(warmPoolReplicas(set, "L")).toBe(0);
    });
  });

  test("a run takes the Agent's limits, else the deployment defaults", () => {
    expect(resolveAgentRunLimits({ runtime: DEFAULTS })).toEqual({
      tier: "M",
      idleTimeoutMinutes: config.agentRuntime.defaultIdleTimeoutMinutes,
      maxDurationHours: config.agentRuntime.defaultTtlHours,
      maxCostUsd: null,
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
      }),
    ).toEqual({
      tier: "L",
      idleTimeoutMinutes: 30,
      maxDurationHours: 48,
      maxCostUsd: 25,
    });
  });

  test("a caller may ask for less than the Agent allows, never more", () => {
    const runtime = {
      ...DEFAULTS,
      tier: "L" as const,
      idleTimeoutMinutes: 30,
      ttlHours: 48,
      maxCostUsd: 25,
    };
    expect(
      resolveAgentRunLimits({
        runtime,
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
      expect(() => resolveAgentRunLimits({ runtime, requested })).toThrow(
        message,
      );
    }
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, tier: "M" },
        requested: { tier: "L" },
      }),
    ).toThrow("Tier L is above this Agent's largest tier M");
    // Without a budget on the Agent, any budget bounds the run.
    expect(
      resolveAgentRunLimits({ runtime: DEFAULTS, requested: { maxCostUsd: 3 } })
        .maxCostUsd,
    ).toBe(3);
  });
});
