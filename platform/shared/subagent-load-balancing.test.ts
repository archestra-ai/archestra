import { describe, expect, it } from "vitest";
import { orderSubagentsByLoadBalancing } from "./subagent-load-balancing";

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

  it("rotates by seed for round_robin", () => {
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

  it("shuffles for random and preserves order for ordered", () => {
    expect(
      orderSubagentsByLoadBalancing(agents, {
        enabled: true,
        algorithm: "ordered",
      }),
    ).toEqual(agents);

    const shuffled = orderSubagentsByLoadBalancing(
      agents,
      { enabled: true, algorithm: "random" },
      { random: () => 0 },
    );
    expect([...shuffled].sort()).toEqual(agents);
  });
});
