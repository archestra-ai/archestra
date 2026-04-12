import { describe, expect, test } from "vitest";
import { type CostHealthInput, computeCostHealth } from "./cost-health";

function makeInput(overrides: Partial<CostHealthInput> = {}): CostHealthInput {
  return {
    limits: [],
    rules: [],
    toonEnabled: true,
    totalAgents: 0,
    agentToolCounts: [],
    agentIds: [],
    ...overrides,
  };
}

describe("computeCostHealth", () => {
  // --- Limits dimension ---

  describe("limits scoring", () => {
    test("score is 100 when no agents exist", () => {
      const result = computeCostHealth(makeInput());
      expect(result.dimensions.limits.score).toBe(100);
    });

    test("score is 0 when agents exist but no limits configured", () => {
      const result = computeCostHealth(
        makeInput({ totalAgents: 3, agentIds: ["a1", "a2", "a3"] }),
      );
      expect(result.dimensions.limits.score).toBe(0);
      expect(result.dimensions.limits.severity).toBe("high");
    });

    test("score is 25 when only org-level limit exists (no per-agent limits)", () => {
      const result = computeCostHealth(
        makeInput({
          totalAgents: 3,
          agentIds: ["a1", "a2", "a3"],
          limits: [{ entityType: "organization", entityId: "org1" }],
        }),
      );
      expect(result.dimensions.limits.score).toBe(25);
      expect(result.dimensions.limits.severity).toBe("high");
    });

    test("score is 100 when org limit and all agents have individual limits", () => {
      const result = computeCostHealth(
        makeInput({
          totalAgents: 2,
          agentIds: ["a1", "a2"],
          limits: [
            { entityType: "organization", entityId: "org1" },
            { entityType: "agent", entityId: "a1" },
            { entityType: "agent", entityId: "a2" },
          ],
        }),
      );
      expect(result.dimensions.limits.score).toBe(100);
    });

    test("score is proportional when org limit and some agents have limits", () => {
      const result = computeCostHealth(
        makeInput({
          totalAgents: 4,
          agentIds: ["a1", "a2", "a3", "a4"],
          limits: [
            { entityType: "organization", entityId: "org1" },
            { entityType: "agent", entityId: "a1" },
          ],
        }),
      );
      // 1/4 = 25%, but floor is 50 when org limit exists
      expect(result.dimensions.limits.score).toBe(50);
    });

    test("score is proportional when only agent-level limits exist (no org limit)", () => {
      const result = computeCostHealth(
        makeInput({
          totalAgents: 4,
          agentIds: ["a1", "a2", "a3", "a4"],
          limits: [
            { entityType: "agent", entityId: "a1" },
            { entityType: "agent", entityId: "a2" },
            { entityType: "agent", entityId: "a3" },
          ],
        }),
      );
      expect(result.dimensions.limits.score).toBe(75);
    });
  });

  // --- Optimization rules dimension ---

  describe("optimization rules scoring", () => {
    test("score is 0 when no rules exist", () => {
      const result = computeCostHealth(makeInput());
      expect(result.dimensions.optimizationRules.score).toBe(0);
    });

    test("score is 50 when rules exist but none are enabled", () => {
      const result = computeCostHealth(
        makeInput({ rules: [{ enabled: false }, { enabled: false }] }),
      );
      expect(result.dimensions.optimizationRules.score).toBe(50);
      expect(result.dimensions.optimizationRules.severity).toBe("moderate");
    });

    test("score is 100 when at least one rule is enabled", () => {
      const result = computeCostHealth(
        makeInput({ rules: [{ enabled: true }, { enabled: false }] }),
      );
      expect(result.dimensions.optimizationRules.score).toBe(100);
    });
  });

  // --- Compression dimension ---

  describe("compression scoring", () => {
    test("score is 100 when TOON is enabled", () => {
      const result = computeCostHealth(makeInput({ toonEnabled: true }));
      expect(result.dimensions.compression.score).toBe(100);
      expect(result.dimensions.compression.severity).toBe("low");
    });

    test("score is 0 when TOON is disabled", () => {
      const result = computeCostHealth(makeInput({ toonEnabled: false }));
      expect(result.dimensions.compression.score).toBe(0);
      expect(result.dimensions.compression.severity).toBe("high");
    });
  });

  // --- Tool hygiene dimension ---

  describe("tool hygiene scoring", () => {
    test("score is 100 when no agents have excessive tools", () => {
      const result = computeCostHealth(
        makeInput({
          agentToolCounts: [
            { agentId: "a1", toolCount: 5 },
            { agentId: "a2", toolCount: 19 },
          ],
        }),
      );
      expect(result.dimensions.toolHygiene.score).toBe(100);
    });

    test("score is 0 when any agent has 20+ tools", () => {
      const result = computeCostHealth(
        makeInput({
          agentToolCounts: [
            { agentId: "a1", toolCount: 5 },
            { agentId: "a2", toolCount: 25 },
          ],
        }),
      );
      expect(result.dimensions.toolHygiene.score).toBe(0);
      expect(result.dimensions.toolHygiene.severity).toBe("high");
    });

    test("boundary: 19 tools is healthy, 20 is excessive", () => {
      const healthy = computeCostHealth(
        makeInput({ agentToolCounts: [{ agentId: "a1", toolCount: 19 }] }),
      );
      const excessive = computeCostHealth(
        makeInput({ agentToolCounts: [{ agentId: "a1", toolCount: 20 }] }),
      );
      expect(healthy.dimensions.toolHygiene.score).toBe(100);
      expect(excessive.dimensions.toolHygiene.score).toBe(0);
    });
  });

  // --- Overall score ---

  describe("overall score", () => {
    test("is average of four dimensions", () => {
      // no agents (limits=100), no rules (rules=0), toon on (compression=100), no tools (hygiene=100)
      const result = computeCostHealth(makeInput());
      expect(result.score).toBe(75);
    });

    test("is 100 when all dimensions are fully configured", () => {
      const result = computeCostHealth(
        makeInput({
          totalAgents: 1,
          agentIds: ["a1"],
          limits: [
            { entityType: "organization", entityId: "org1" },
            { entityType: "agent", entityId: "a1" },
          ],
          rules: [{ enabled: true }],
          toonEnabled: true,
          agentToolCounts: [{ agentId: "a1", toolCount: 5 }],
        }),
      );
      expect(result.score).toBe(100);
    });

    test("is 0 when nothing is configured and agents have excessive tools", () => {
      const result = computeCostHealth(
        makeInput({
          totalAgents: 1,
          agentIds: ["a1"],
          limits: [],
          rules: [],
          toonEnabled: false,
          agentToolCounts: [{ agentId: "a1", toolCount: 25 }],
        }),
      );
      expect(result.score).toBe(0);
    });
  });

  // --- Severity thresholds ---

  describe("severity mapping", () => {
    test("low when score >= 80", () => {
      const result = computeCostHealth(
        makeInput({ rules: [{ enabled: true }] }),
      );
      expect(result.dimensions.optimizationRules.severity).toBe("low");
    });

    test("moderate when score >= 40 and < 80", () => {
      const result = computeCostHealth(
        makeInput({ rules: [{ enabled: false }] }),
      );
      expect(result.dimensions.optimizationRules.severity).toBe("moderate");
    });

    test("high when score < 40", () => {
      const result = computeCostHealth(
        makeInput({
          totalAgents: 1,
          agentIds: ["a1"],
          limits: [{ entityType: "organization", entityId: "org1" }],
        }),
      );
      expect(result.dimensions.limits.severity).toBe("high");
    });
  });

  // --- Links ---

  describe("dimension links", () => {
    test("each dimension links to its fix page", () => {
      const result = computeCostHealth(makeInput());
      expect(result.dimensions.limits.link).toBe("/llm/limits");
      expect(result.dimensions.optimizationRules.link).toBe("/llm/optimization-rules");
      expect(result.dimensions.compression.link).toBe("/settings/llm");
      expect(result.dimensions.toolHygiene.link).toBe("/agents");
    });
  });
});
