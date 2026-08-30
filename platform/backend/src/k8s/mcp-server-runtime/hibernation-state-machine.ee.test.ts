// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import {
  MCP_DEPLOYMENT_STATES,
  type McpDeploymentState,
} from "@archestra/shared";
import { describe, expect, test } from "@/test";
import {
  ALLOWED_ACTION_TRANSITIONS,
  assertActionTransition,
  deriveDeploymentState,
  isActionTransitionAllowed,
} from "./hibernation-state-machine.ee";

type DeploymentFacts = Parameters<typeof deriveDeploymentState>[0];

function facts(overrides: Partial<DeploymentFacts> = {}): DeploymentFacts {
  return {
    exists: true,
    hasHibernationAnnotation: false,
    replicas: 1,
    availableReplicas: 1,
    podFailure: null,
    ...overrides,
  };
}

function expectedDeploymentDecision(
  deploymentFacts: DeploymentFacts,
  cachedState: McpDeploymentState,
): ReturnType<typeof deriveDeploymentState> {
  if (!deploymentFacts.exists) {
    return { kind: "state", state: "not_created" };
  }

  if (deploymentFacts.hasHibernationAnnotation) {
    if (deploymentFacts.replicas === 0) {
      return { kind: "state", state: "hibernated" };
    }
    if (deploymentFacts.availableReplicas > 0) return { kind: "finish-wake" };
    if (
      deploymentFacts.podFailure?.failed &&
      !deploymentFacts.podFailure.transient
    ) {
      return { kind: "state", state: "failed" };
    }
    return { kind: "state", state: "waking" };
  }

  if (deploymentFacts.availableReplicas > 0) {
    return { kind: "state", state: "running" };
  }
  if (deploymentFacts.podFailure?.failed) {
    return {
      kind: "state",
      state: deploymentFacts.podFailure.transient ? "pending" : "failed",
    };
  }
  if (cachedState === "running") return { kind: "debounce-running" };
  if (cachedState === "hibernated" || cachedState === "waking") {
    return { kind: "state", state: "pending" };
  }
  return { kind: "state", state: cachedState };
}

describe("deriveDeploymentState hibernation overlay", () => {
  test("zero annotated replicas is hibernated", () => {
    expect(
      deriveDeploymentState(
        facts({
          hasHibernationAnnotation: true,
          replicas: 0,
          availableReplicas: 0,
        }),
        "running",
      ),
    ).toEqual({ kind: "state", state: "hibernated" });
  });

  test("an annotated unavailable deployment is waking", () => {
    expect(
      deriveDeploymentState(
        facts({
          hasHibernationAnnotation: true,
          availableReplicas: 0,
        }),
        "hibernated",
      ),
    ).toEqual({ kind: "state", state: "waking" });
  });

  test("a terminal mid-wake pod failure is failed", () => {
    expect(
      deriveDeploymentState(
        facts({
          hasHibernationAnnotation: true,
          availableReplicas: 0,
          podFailure: { failed: true, transient: false },
        }),
        "waking",
      ),
    ).toEqual({ kind: "state", state: "failed" });
  });

  test("a transient mid-wake pull failure remains waking", () => {
    expect(
      deriveDeploymentState(
        facts({
          hasHibernationAnnotation: true,
          availableReplicas: 0,
          podFailure: { failed: true, transient: true },
        }),
        "waking",
      ),
    ).toEqual({ kind: "state", state: "waking" });
  });

  test("an annotated available deployment finishes its wake", () => {
    expect(
      deriveDeploymentState(
        facts({ hasHibernationAnnotation: true }),
        "waking",
      ),
    ).toEqual({ kind: "finish-wake" });
  });

  test("the marker wins over a pod failure while scaled to zero", () => {
    expect(
      deriveDeploymentState(
        facts({
          hasHibernationAnnotation: true,
          replicas: 0,
          availableReplicas: 0,
          podFailure: { failed: true, transient: false },
        }),
        "running",
      ),
    ).toEqual({ kind: "state", state: "hibernated" });
  });

  test("without a marker delegates to ordinary derivation", () => {
    expect(deriveDeploymentState(facts(), "pending")).toEqual({
      kind: "state",
      state: "running",
    });
    expect(
      deriveDeploymentState(
        facts({ replicas: 0, availableReplicas: 0 }),
        "running",
      ),
    ).toEqual({ kind: "debounce-running" });
    expect(
      deriveDeploymentState(
        facts({
          availableReplicas: 0,
          podFailure: { failed: true, transient: false },
        }),
        "pending",
      ),
    ).toEqual({ kind: "state", state: "failed" });
    expect(
      deriveDeploymentState(
        facts({
          availableReplicas: 0,
          podFailure: { failed: true, transient: true },
        }),
        "pending",
      ),
    ).toEqual({ kind: "state", state: "pending" });
  });

  test("marker loss releases hibernated and waking states to pending", () => {
    for (const cachedState of ["hibernated", "waking"] as const) {
      expect(
        deriveDeploymentState(
          facts({ replicas: 0, availableReplicas: 0 }),
          cachedState,
        ),
      ).toEqual({ kind: "state", state: "pending" });
    }
  });

  test("defines the hibernation decision for every cached state and cluster fact", () => {
    const decisionKinds = new Set<string>();
    for (const exists of [true, false]) {
      for (const hasHibernationAnnotation of [true, false]) {
        for (const replicas of [0, 1, 3]) {
          for (const availableReplicas of [0, 1]) {
            for (const podFailure of [
              null,
              { failed: false, transient: false },
              { failed: true, transient: false },
              { failed: true, transient: true },
            ]) {
              for (const cachedState of MCP_DEPLOYMENT_STATES) {
                const deploymentFacts = {
                  exists,
                  hasHibernationAnnotation,
                  replicas,
                  availableReplicas,
                  podFailure,
                };
                const decision = deriveDeploymentState(
                  deploymentFacts,
                  cachedState,
                );
                expect(decision).toEqual(
                  expectedDeploymentDecision(deploymentFacts, cachedState),
                );
                decisionKinds.add(decision.kind);
              }
            }
          }
        }
      }
    }
    expect([...decisionKinds].sort()).toEqual([
      "debounce-running",
      "finish-wake",
      "state",
    ]);
  });
});

describe("action transition table", () => {
  test("contains only the hibernation lifecycle actions", () => {
    expect(isActionTransitionAllowed("running", "hibernated")).toBe(true);
    expect(isActionTransitionAllowed("hibernated", "waking")).toBe(true);
    expect(isActionTransitionAllowed("waking", "running")).toBe(true);
    expect(isActionTransitionAllowed("waking", "hibernated")).toBe(true);
    expect(isActionTransitionAllowed("waking", "failed")).toBe(true);
    expect(isActionTransitionAllowed("running", "waking")).toBe(false);
  });

  test("self-transitions are idempotent", () => {
    for (const state of MCP_DEPLOYMENT_STATES) {
      expect(isActionTransitionAllowed(state, state)).toBe(true);
      expect(ALLOWED_ACTION_TRANSITIONS[state].has(state)).toBe(false);
    }
  });

  test("unconfirmed states cannot perform actions", () => {
    for (const state of [
      "not_created",
      "pending",
      "failed",
      "succeeded",
    ] as McpDeploymentState[]) {
      expect(ALLOWED_ACTION_TRANSITIONS[state].size).toBe(0);
    }
  });
});

describe("assertActionTransition", () => {
  test("allows a legal action", () => {
    expect(
      assertActionTransition({
        from: "running",
        to: "hibernated",
        reason: "idle past window",
        deploymentName: "mcp-test",
      }),
    ).toBe(true);
  });

  test("refuses an illegal action without throwing", () => {
    expect(
      assertActionTransition({
        from: "running",
        to: "waking",
        reason: "bogus",
        deploymentName: "mcp-test",
      }),
    ).toBe(false);
  });
});
