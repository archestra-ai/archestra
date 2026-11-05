import { describe, expect, it } from "vitest";
import {
  orderSubagentsByLoadBalancing,
  StoredSubagentLoadBalancingConfigSchema,
  SubagentLoadBalancingConfigSchema,
} from "./subagent-load-balancing";

describe("orderSubagentsByLoadBalancing", () => {
  const agents = ["a", "b", "c"];

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
