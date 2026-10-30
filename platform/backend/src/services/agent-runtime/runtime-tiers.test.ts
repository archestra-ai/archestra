import { describe, expect, test } from "vitest";
import config from "@/config";
import {
  AGENT_RUNTIME_TIER_RESOURCES,
  agentRuntimeTier,
  resolveAgentRunLimits,
  resolveRunResources,
  warmTierCandidates,
} from "./runtime-tiers";

const DEFAULTS = {
  resources: null,
  tier: null,
  idleTimeoutMinutes: null,
  ttlHours: null,
  maxCostUsd: null,
};

describe("runtime tiers", () => {
  test("an Agent without a tier runs at M; explicit resources replace the tier", () => {
    expect(agentRuntimeTier(DEFAULTS)).toBe("M");
    expect(agentRuntimeTier({ resources: null, tier: "L" })).toBe("L");
    expect(
      agentRuntimeTier({ resources: { cpuRequest: "7" }, tier: "L" }),
    ).toBeNull();
    expect(resolveRunResources(DEFAULTS, "S")).toEqual(
      AGENT_RUNTIME_TIER_RESOURCES.S,
    );
    expect(resolveRunResources(DEFAULTS, null)).toEqual(
      AGENT_RUNTIME_TIER_RESOURCES.M,
    );
    expect(
      resolveRunResources({ resources: { cpuRequest: "7" }, tier: null }, "S"),
    ).toEqual({ cpuRequest: "7" });
  });

  test("the tiers are sized so S, M and L fit seven, three and two runs on an 8-vCPU node", () => {
    expect(AGENT_RUNTIME_TIER_RESOURCES).toEqual({
      S: { cpuRequest: "1", memoryRequest: "2Gi", memoryLimit: "4Gi" },
      M: { cpuRequest: "2", memoryRequest: "4Gi", memoryLimit: "8Gi" },
      L: { cpuRequest: "3500m", memoryRequest: "12Gi", memoryLimit: "18Gi" },
    });
  });

  test("a warm Sandbox may come from the requested tier, then the larger neighbour within the Agent's, then the smaller", () => {
    expect(warmTierCandidates("S", "L")).toEqual(["S", "M"]);
    expect(warmTierCandidates("M", "L")).toEqual(["M", "L", "S"]);
    expect(warmTierCandidates("M", "M")).toEqual(["M", "S"]);
    expect(warmTierCandidates("L", "L")).toEqual(["L", "M"]);
    expect(warmTierCandidates("S", "S")).toEqual(["S"]);
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
    ).toThrow("Tier L is above this Agent's tier M");
    expect(() =>
      resolveAgentRunLimits({
        runtime: { ...DEFAULTS, resources: { cpuRequest: "7" } },
        requested: { tier: "S" },
      }),
    ).toThrow("explicit resources");
    // Without a budget on the Agent, any budget bounds the run.
    expect(
      resolveAgentRunLimits({ runtime: DEFAULTS, requested: { maxCostUsd: 3 } })
        .maxCostUsd,
    ).toBe(3);
  });
});
