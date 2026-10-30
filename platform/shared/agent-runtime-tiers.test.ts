import { describe, expect, test } from "vitest";
import {
  AgentRuntimeTierSettingsSchema,
  agentRuntimeTierProblems,
  DEFAULT_AGENT_RUNTIME_TIERS,
  resolveAgentRuntimeTiers,
} from "./agent-runtime-tiers";

describe("resolveAgentRuntimeTiers", () => {
  test("gives the code defaults when the organization sets nothing", () => {
    expect(resolveAgentRuntimeTiers(null)).toEqual(DEFAULT_AGENT_RUNTIME_TIERS);
    expect(DEFAULT_AGENT_RUNTIME_TIERS.L).toEqual({
      cpuRequest: "8",
      cpuLimit: null,
      memoryRequest: "16Gi",
      memoryLimit: "32Gi",
      warmPoolSize: 0,
    });
  });

  test("replaces only the fields an administrator set", () => {
    const tiers = resolveAgentRuntimeTiers({
      L: { cpuRequest: "12", memoryLimit: "48Gi", warmPoolSize: 1 },
      S: { cpuLimit: "2" },
    });
    expect(tiers.L).toEqual({
      cpuRequest: "12",
      cpuLimit: null,
      memoryRequest: "16Gi",
      memoryLimit: "48Gi",
      warmPoolSize: 1,
    });
    expect(tiers.S.cpuLimit).toBe("2");
    expect(tiers.M).toEqual(DEFAULT_AGENT_RUNTIME_TIERS.M);
    // The defaults themselves are never mutated.
    expect(DEFAULT_AGENT_RUNTIME_TIERS.L.cpuRequest).toBe("8");
  });

  test("ignores stored values that do not validate", () => {
    const tiers = resolveAgentRuntimeTiers({
      M: {
        cpuRequest: "lots",
        memoryRequest: 4,
        warmPoolSize: -1,
        extra: true,
      },
    });
    expect(tiers.M).toEqual(DEFAULT_AGENT_RUNTIME_TIERS.M);
  });
});

describe("AgentRuntimeTierSettingsSchema", () => {
  test("accepts Kubernetes quantities and refuses anything else", () => {
    expect(
      AgentRuntimeTierSettingsSchema.safeParse({
        L: { cpuRequest: "3500m", memoryRequest: "12Gi", cpuLimit: null },
      }).success,
    ).toBe(true);
    for (const value of [
      { L: { cpuRequest: "4 cores" } },
      { L: { memoryLimit: "16GB" } },
      { L: { warmPoolSize: 11 } },
      { XL: {} },
      { L: { gpu: "1" } },
    ])
      expect(AgentRuntimeTierSettingsSchema.safeParse(value).success).toBe(
        false,
      );
  });
});

describe("agentRuntimeTierProblems", () => {
  test("has none for the defaults", () => {
    expect(agentRuntimeTierProblems(DEFAULT_AGENT_RUNTIME_TIERS)).toEqual([]);
  });

  test("names a limit below its request and tiers out of order", () => {
    const tiers = resolveAgentRuntimeTiers({
      M: { memoryLimit: "3Gi", cpuLimit: "1500m" },
      L: { cpuRequest: "1", memoryRequest: "1024Mi" },
    });
    expect(agentRuntimeTierProblems(tiers)).toEqual([
      "Tier M: the CPU limit is below the CPU request",
      "Tier M: the memory limit is below the memory request",
      "Tier M has a lower memory limit than tier S",
      "Tier M limits CPU and tier S does not",
      "Tier L requests less than tier M",
    ]);
  });

  test("names a larger tier whose memory or CPU limit is lower than the tier below it", () => {
    // M requests more than S but would cap a promoted S run at 10Gi instead of S's 12Gi.
    expect(
      agentRuntimeTierProblems(
        resolveAgentRuntimeTiers({
          S: { memoryLimit: "12Gi" },
          M: { memoryLimit: "10Gi" },
        }),
      ),
    ).toEqual(["Tier M has a lower memory limit than tier S"]);
    // A CPU limit on M where S has none, or a lower one than S's, is lower too.
    expect(
      agentRuntimeTierProblems(
        resolveAgentRuntimeTiers({ M: { cpuLimit: "6" } }),
      ),
    ).toEqual(["Tier M limits CPU and tier S does not"]);
    expect(
      agentRuntimeTierProblems(
        resolveAgentRuntimeTiers({
          S: { cpuLimit: "4" },
          M: { cpuLimit: "3500m" },
          L: { cpuLimit: "16" },
        }),
      ),
    ).toEqual([
      "Tier M: the CPU limit is below the CPU request",
      "Tier M has a lower CPU limit than tier S",
    ]);
    // Limits that grow with the tiers are fine.
    expect(
      agentRuntimeTierProblems(
        resolveAgentRuntimeTiers({
          S: { cpuLimit: "2" },
          M: { cpuLimit: "4" },
          L: { cpuLimit: "8" },
        }),
      ),
    ).toEqual([]);
  });

  test("compares binary and decimal units by value", () => {
    const tiers = resolveAgentRuntimeTiers({
      M: { memoryRequest: "8192Mi", memoryLimit: "16G" },
    });
    expect(agentRuntimeTierProblems(tiers)).toEqual([]);
  });
});
