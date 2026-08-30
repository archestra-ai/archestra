import { MCP_DEPLOYMENT_STATES } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import {
  applyDeploymentObservation,
  deriveOrdinaryDeploymentState,
  type OrdinaryDeploymentFacts,
} from "./hibernation-state-machine";

function facts(
  overrides: Partial<OrdinaryDeploymentFacts> = {},
): OrdinaryDeploymentFacts {
  return {
    exists: true,
    availableReplicas: 1,
    podFailure: null,
    ...overrides,
  };
}

function expectedDecision(
  facts: OrdinaryDeploymentFacts,
  cachedState: (typeof MCP_DEPLOYMENT_STATES)[number],
) {
  if (!facts.exists) return { kind: "state" as const, state: "not_created" };
  if (facts.availableReplicas > 0) {
    return { kind: "state" as const, state: "running" };
  }
  if (facts.podFailure?.failed) {
    return {
      kind: "state" as const,
      state: facts.podFailure.transient ? "pending" : "failed",
    };
  }
  if (cachedState === "running") return { kind: "debounce-running" as const };
  return { kind: "state" as const, state: cachedState };
}

describe("deriveOrdinaryDeploymentState", () => {
  test("a missing deployment is not_created for every cached state", () => {
    for (const cachedState of MCP_DEPLOYMENT_STATES) {
      expect(
        deriveOrdinaryDeploymentState(facts({ exists: false }), cachedState),
      ).toEqual({ kind: "state", state: "not_created" });
    }
  });

  test("available replicas are running", () => {
    expect(deriveOrdinaryDeploymentState(facts(), "pending")).toEqual({
      kind: "state",
      state: "running",
    });
  });

  test("a terminal pod failure is failed", () => {
    expect(
      deriveOrdinaryDeploymentState(
        facts({
          availableReplicas: 0,
          podFailure: { failed: true, transient: false },
        }),
        "pending",
      ),
    ).toEqual({ kind: "state", state: "failed" });
  });

  test("a transient pull failure stays pending", () => {
    expect(
      deriveOrdinaryDeploymentState(
        facts({
          availableReplicas: 0,
          podFailure: { failed: true, transient: true },
        }),
        "pending",
      ),
    ).toEqual({ kind: "state", state: "pending" });
  });

  test("an unavailable running deployment is debounced", () => {
    expect(
      deriveOrdinaryDeploymentState(facts({ availableReplicas: 0 }), "running"),
    ).toEqual({ kind: "debounce-running" });
  });

  test("other unavailable deployments keep their cached state", () => {
    for (const cachedState of MCP_DEPLOYMENT_STATES.filter(
      (state) => state !== "running",
    )) {
      expect(
        deriveOrdinaryDeploymentState(
          facts({ availableReplicas: 0 }),
          cachedState,
        ),
      ).toEqual({ kind: "state", state: cachedState });
    }
  });

  test("defines the ordinary decision for every cached state and cluster fact", () => {
    const decisionKinds = new Set<string>();
    for (const exists of [true, false]) {
      for (const availableReplicas of [0, 1]) {
        for (const podFailure of [
          null,
          { failed: false, transient: false },
          { failed: true, transient: false },
          { failed: true, transient: true },
        ]) {
          for (const cachedState of MCP_DEPLOYMENT_STATES) {
            const clusterFacts = { exists, availableReplicas, podFailure };
            const decision = deriveOrdinaryDeploymentState(
              clusterFacts,
              cachedState,
            );
            expect(decision).toEqual(
              expectedDecision(clusterFacts, cachedState),
            );
            decisionKinds.add(decision.kind);
          }
        }
      }
    }
    expect([...decisionKinds].sort()).toEqual(["debounce-running", "state"]);
  });
});

describe("applyDeploymentObservation", () => {
  test("every observed state replaces every cached state", () => {
    for (const cachedState of MCP_DEPLOYMENT_STATES) {
      for (const observedState of MCP_DEPLOYMENT_STATES) {
        expect(applyDeploymentObservation({ cachedState, observedState })).toBe(
          observedState,
        );
      }
    }
  });
});
