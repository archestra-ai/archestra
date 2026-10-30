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
      cpuRequest: "4",
      cpuLimit: null,
      memoryRequest: "8Gi",
      memoryLimit: "16Gi",
      warmPoolSize: 0,
    });
  });

  test("replaces only the fields an administrator set", () => {
    const tiers = resolveAgentRuntimeTiers({
      L: { cpuRequest: "6", memoryLimit: "24Gi", warmPoolSize: 1 },
      S: { cpuLimit: "1" },
    });
    expect(tiers.L).toEqual({
      cpuRequest: "6",
      cpuLimit: null,
      memoryRequest: "8Gi",
      memoryLimit: "24Gi",
      warmPoolSize: 1,
    });
    expect(tiers.S.cpuLimit).toBe("1");
    expect(tiers.M).toEqual(DEFAULT_AGENT_RUNTIME_TIERS.M);
    // The defaults themselves are never mutated.
    expect(DEFAULT_AGENT_RUNTIME_TIERS.L.cpuRequest).toBe("4");
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
    // M requests more than S but would cap a promoted S run at 6Gi instead of S's 8Gi.
    expect(
      agentRuntimeTierProblems(
        resolveAgentRuntimeTiers({
          S: { memoryLimit: "8Gi" },
          M: { memoryLimit: "6Gi" },
        }),
      ),
    ).toEqual(["Tier M has a lower memory limit than tier S"]);
    // A CPU limit on M where S has none, or a lower one than S's, is lower too.
    expect(
      agentRuntimeTierProblems(
        resolveAgentRuntimeTiers({ M: { cpuLimit: "4" } }),
      ),
    ).toEqual(["Tier M limits CPU and tier S does not"]);
    expect(
      agentRuntimeTierProblems(
        resolveAgentRuntimeTiers({
          S: { cpuLimit: "2" },
          M: { cpuLimit: "1500m" },
          L: { cpuLimit: "8" },
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
          S: { cpuLimit: "1" },
          M: { cpuLimit: "2" },
          L: { cpuLimit: "4" },
        }),
      ),
    ).toEqual([]);
  });

  test("compares binary and decimal units by value", () => {
    const tiers = resolveAgentRuntimeTiers({
      M: { memoryRequest: "4096Mi", memoryLimit: "8G" },
    });
    expect(agentRuntimeTierProblems(tiers)).toEqual([]);
  });
});
