import {
  MCP_DEPLOYMENT_STATES,
  type McpDeploymentState,
} from "@archestra/shared";
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

  test("is total across ordinary facts and cached states", () => {
    const decisionKinds = new Set<string>();
    for (const exists of [true, false]) {
      for (const availableReplicas of [0, 1]) {
        for (const podFailure of [
          null,
          { failed: true, transient: false },
          { failed: true, transient: true },
        ]) {
          for (const cachedState of MCP_DEPLOYMENT_STATES) {
            const decision = deriveOrdinaryDeploymentState(
              { exists, availableReplicas, podFailure },
              cachedState,
            );
            expect(decision).toBeDefined();
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

  test("returns a deployment state", () => {
    const observed: McpDeploymentState = "failed";
    expect(
      applyDeploymentObservation({
        cachedState: "pending",
        observedState: observed,
      }),
    ).toBe(observed);
  });
});
