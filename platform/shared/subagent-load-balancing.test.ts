import { describe, expect, it } from "vitest";
import {
  orderSubagentsByLoadBalancing,
  resolveSubagentLoadBalancerScopeKey,
  StoredSubagentLoadBalancingConfigSchema,
  SubagentLoadBalancingConfigSchema,
  stepSmoothWeightedRoundRobin,
} from "./subagent-load-balancing";

describe("orderSubagentsByLoadBalancing", () => {
  const agents = ["a", "b", "c"];

  it("resolves scope key in priority order: user -> service_account -> team -> org -> default", () => {
    expect(
      resolveSubagentLoadBalancerScopeKey({
        userId: "u-1",
        serviceAccountId: "sa-1",
        teamId: "t-1",
        organizationId: "o-1",
      }),
    ).toBe("user:u-1");
    expect(
      resolveSubagentLoadBalancerScopeKey({
        userId: null,
        serviceAccountId: "sa-1",
        teamId: "t-1",
        organizationId: "o-1",
      }),
    ).toBe("service_account:sa-1");
    expect(
      resolveSubagentLoadBalancerScopeKey({
        userId: "",
        teamId: "t-1",
        organizationId: "o-1",
      }),
    ).toBe("team:t-1");
    expect(
      resolveSubagentLoadBalancerScopeKey({
        organizationId: "o-1",
      }),
    ).toBe("org:o-1");
    expect(resolveSubagentLoadBalancerScopeKey({})).toBe("default");
    expect(resolveSubagentLoadBalancerScopeKey(null)).toBe("default");
    expect(resolveSubagentLoadBalancerScopeKey("  user:custom  ")).toBe(
      "user:custom",
    );
  });

  it("keeps assignment order when load balancing is null or disabled", () => {
    expect(orderSubagentsByLoadBalancing(agents, null)).toEqual(agents);
    expect(
      orderSubagentsByLoadBalancing(agents, {
        enabled: false,
        algorithm: "round_robin",
      }),
    ).toEqual(agents);
  });

  it("rotates primary and fallback order by seed for round_robin across any agent count", () => {
    expect(
      orderSubagentsByLoadBalancing(
        agents,
        { enabled: true, algorithm: "round_robin" },
        { seed: 0 },
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      orderSubagentsByLoadBalancing(
        agents,
        { enabled: true, algorithm: "round_robin" },
        { seed: 1 },
      ),
    ).toEqual(["b", "c", "a"]);
    expect(
      orderSubagentsByLoadBalancing(
        agents,
        { enabled: true, algorithm: "round_robin" },
        { seed: 2 },
      ),
    ).toEqual(["c", "a", "b"]);
    // Next full cycle (round 1): primary is "a" again, and fallback tail rotates so "c" is first fallback
    expect(
      orderSubagentsByLoadBalancing(
        agents,
        { enabled: true, algorithm: "round_robin" },
        { seed: 3 },
      ),
    ).toEqual(["a", "c", "b"]);

    const fiveAgents = ["a1", "a2", "a3", "a4", "a5"];
    const primaries = Array.from(
      { length: 10 },
      (_, seed) =>
        orderSubagentsByLoadBalancing(
          fiveAgents,
          { enabled: true, algorithm: "round_robin" },
          { seed },
        )[0],
    );
    expect(primaries).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
  });

  it("samples without replacement according to weights for weighted", () => {
    const ordered = orderSubagentsByLoadBalancing(
      agents,
      {
        enabled: true,
        algorithm: "weighted",
        weights: { a: 10, b: 90, c: 1 },
      },
      { random: () => 0.5 },
    );
    expect(ordered[0]).toBe("b");
    expect([...ordered].sort()).toEqual(agents);
  });

  it("distributes weighted selections smoothly and deterministically in exact weight ratios when seeded", () => {
    const weightedConfig = {
      enabled: true,
      algorithm: "weighted" as const,
      weights: { a: 3, b: 2, c: 1 },
    };
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const primaries: string[] = [];
    for (let seed = 0; seed < 6; seed++) {
      const ordered = orderSubagentsByLoadBalancing(agents, weightedConfig, {
        seed,
        scopeKey: "user:alice",
      });
      expect([...ordered].sort()).toEqual(agents);
      const primary = ordered[0] ?? "";
      primaries.push(primary);
      counts[primary] = (counts[primary] ?? 0) + 1;
    }
    expect(counts).toEqual({ a: 3, b: 2, c: 1 });
    // Smooth weighted round-robin never clusters all 3 "a" selections consecutively
    expect(primaries.join("")).not.toContain("aaa");

    // Step helper tracks state across calls
    let currentWeights: Record<string, number> = {};
    let queue = [...agents];
    const stepPrimaries: string[] = [];
    for (let i = 0; i < 6; i++) {
      const stepped = stepSmoothWeightedRoundRobin({
        availableIds: agents,
        weights: weightedConfig.weights,
        currentWeights,
        tieBreakOrder: queue,
      });
      currentWeights = stepped.nextCurrentWeights;
      if (stepped.chosenId) {
        stepPrimaries.push(stepped.chosenId);
        queue = [
          ...queue.filter((id) => id !== stepped.chosenId),
          stepped.chosenId,
        ];
      }
    }
    expect(stepPrimaries).toEqual(["a", "b", "c", "a", "b", "a"]);
  });

  it("produces deterministic per-scope random permutations when seeded", () => {
    const firstAlice = orderSubagentsByLoadBalancing(
      agents,
      { enabled: true, algorithm: "random" },
      { seed: 0, scopeKey: "user:alice" },
    );
    const repeatAlice = orderSubagentsByLoadBalancing(
      agents,
      { enabled: true, algorithm: "random" },
      { seed: 0, scopeKey: "user:alice" },
    );
    expect(firstAlice).toEqual(repeatAlice);
    expect([...firstAlice].sort()).toEqual(agents);

    const aliceSequence = Array.from({ length: 8 }, (_, seed) =>
      orderSubagentsByLoadBalancing(
        agents,
        { enabled: true, algorithm: "random" },
        { seed, scopeKey: "user:alice" },
      ).join(","),
    );
    const bobSequence = Array.from({ length: 8 }, (_, seed) =>
      orderSubagentsByLoadBalancing(
        agents,
        { enabled: true, algorithm: "random" },
        { seed, scopeKey: "user:bob" },
      ).join(","),
    );
    expect(aliceSequence).not.toEqual(bobSequence);
  });

  it("shuffles for random and normalizes legacy stored configs", () => {
    const shuffled = orderSubagentsByLoadBalancing(
      agents,
      { enabled: true, algorithm: "random" },
      { random: () => 0 },
    );
    expect([...shuffled].sort()).toEqual(agents);

    expect(
      SubagentLoadBalancingConfigSchema.safeParse({
        enabled: true,
        algorithm: "ordered",
      }).success,
    ).toBe(false);

    const parsedLegacy = StoredSubagentLoadBalancingConfigSchema.parse({
      enabled: true,
      algorithm: "ordered",
      retries: 2,
      fallbackEnabled: true,
      maxFallbacks: 1,
    });
    expect(parsedLegacy).toEqual({
      enabled: true,
      algorithm: "round_robin",
      retries: 2,
      fallbackEnabled: true,
    });
  });
});
