// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import {
  MCP_DEPLOYMENT_STATES,
  type McpDeploymentState,
} from "@archestra/shared";
import { describe, expect, test } from "@/test";
import {
  ALLOWED_ACTION_TRANSITIONS,
  assertTransition,
  type DeploymentFacts,
  deriveDeploymentState,
  isTransitionAllowed,
} from "./hibernation-state-machine.ee";

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

describe("deriveDeploymentState", () => {
  test("a missing deployment is not_created whatever we cached", () => {
    for (const cached of MCP_DEPLOYMENT_STATES) {
      expect(deriveDeploymentState(facts({ exists: false }), cached)).toEqual({
        kind: "state",
        state: "not_created",
      });
    }
  });

  describe("carrying our ownership marker", () => {
    test("zero replicas is hibernated, not pending", () => {
      // A zero-replica deployment is never "available", so without this the
      // debounce would grind it into a permanent "pending" — idle would look
      // broken in the registry.
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

    test("scaled up but not yet available is waking", () => {
      expect(
        deriveDeploymentState(
          facts({
            hasHibernationAnnotation: true,
            replicas: 1,
            availableReplicas: 0,
          }),
          "hibernated",
        ),
      ).toEqual({ kind: "state", state: "waking" });
    });

    test("scaled up AND available means a wake to finish, not a state to adopt", () => {
      // completeWake never landed, or the process running it died. The
      // deployment is verifiably up, so the refresh finishes the job itself.
      expect(
        deriveDeploymentState(
          facts({
            hasHibernationAnnotation: true,
            replicas: 1,
            availableReplicas: 1,
          }),
          "waking",
        ),
      ).toEqual({ kind: "finish-wake" });
    });

    test("the marker wins over a pod failure", () => {
      // Ours-and-asleep is decided before the ordinary failure rules, so a
      // dying pod on the way down cannot make an idle server look broken.
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
  });

  describe("without our marker", () => {
    test("available replicas are running", () => {
      expect(deriveDeploymentState(facts(), "pending")).toEqual({
        kind: "state",
        state: "running",
      });
    });

    test("zero replicas scaled down by someone else is never claimed as hibernated", () => {
      // The single most important row in the table: replicas 0 WITHOUT the
      // marker belongs to whoever scaled it, and we must not adopt it.
      const decision = deriveDeploymentState(
        facts({ replicas: 0, availableReplicas: 0 }),
        "running",
      );
      expect(decision).toEqual({ kind: "debounce-running" });
    });

    test("a terminal pod failure is failed", () => {
      expect(
        deriveDeploymentState(
          facts({
            availableReplicas: 0,
            podFailure: { failed: true, transient: false },
          }),
          "pending",
        ),
      ).toEqual({ kind: "state", state: "failed" });
    });

    test("a transient pull failure stays pending so the kubelet can retry", () => {
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

    test("hibernated or waking with the marker gone is released to pending", () => {
      // Nothing else can reach these states once the annotation is absent, so
      // without this they stick forever and the UI reads "Hibernated" for a
      // deployment nobody is holding asleep.
      for (const cached of ["hibernated", "waking"] as const) {
        expect(
          deriveDeploymentState(
            facts({ replicas: 0, availableReplicas: 0 }),
            cached,
          ),
        ).toEqual({ kind: "state", state: "pending" });
      }
    });

    test("anything else keeps the state it had", () => {
      expect(
        deriveDeploymentState(facts({ availableReplicas: 0 }), "failed"),
      ).toEqual({ kind: "state", state: "failed" });
    });
  });

  test("is total — every combination of facts yields a decision", () => {
    const decisions = new Set<string>();
    for (const exists of [true, false]) {
      for (const hasHibernationAnnotation of [true, false]) {
        for (const replicas of [0, 1, 3]) {
          for (const availableReplicas of [0, 1]) {
            for (const podFailure of [
              null,
              { failed: true, transient: false },
              { failed: true, transient: true },
            ]) {
              for (const cached of MCP_DEPLOYMENT_STATES) {
                const decision = deriveDeploymentState(
                  {
                    exists,
                    hasHibernationAnnotation,
                    replicas,
                    availableReplicas,
                    podFailure,
                  },
                  cached,
                );
                expect(decision).toBeDefined();
                decisions.add(decision.kind);
              }
            }
          }
        }
      }
    }
    // All three outcomes are genuinely reachable; a derivation that could only
    // ever return a plain state would have silently dropped the self-heal.
    expect([...decisions].sort()).toEqual([
      "debounce-running",
      "finish-wake",
      "state",
    ]);
  });
});

describe("action transition table", () => {
  test("covers every state, and every target is a real state", () => {
    expect(Object.keys(ALLOWED_ACTION_TRANSITIONS).sort()).toEqual(
      [...MCP_DEPLOYMENT_STATES].sort(),
    );
    for (const targets of Object.values(ALLOWED_ACTION_TRANSITIONS)) {
      for (const target of targets) {
        expect(MCP_DEPLOYMENT_STATES).toContain(target);
      }
    }
  });

  test("no state lists itself — self-transitions are idempotent no-ops instead", () => {
    for (const [from, targets] of Object.entries(ALLOWED_ACTION_TRANSITIONS)) {
      expect(targets.has(from as McpDeploymentState)).toBe(false);
    }
  });

  test("re-entering the current state is always allowed", () => {
    // This is what makes every lifecycle operation idempotent: hibernating an
    // already-hibernated deployment is a legal nothing, not a refused move.
    for (const state of MCP_DEPLOYMENT_STATES) {
      expect(isTransitionAllowed(state, state, "action")).toBe(true);
    }
  });

  test("the hibernation cycle is walkable end to end", () => {
    expect(isTransitionAllowed("running", "hibernated", "action")).toBe(true);
    expect(isTransitionAllowed("hibernated", "waking", "action")).toBe(true);
    expect(isTransitionAllowed("waking", "running", "action")).toBe(true);
    // Ran out of wait budget — retryable, marker deliberately kept.
    expect(isTransitionAllowed("waking", "hibernated", "action")).toBe(true);
    // A pod that genuinely cannot start — terminal.
    expect(isTransitionAllowed("waking", "failed", "action")).toBe(true);
  });

  test("only a serving deployment may be scaled down, and only a failed wake may return to sleep", () => {
    // Two ways to legally reach "hibernated" by acting, and no others.
    // Hibernating is a decision about a SERVING deployment; reaching it from
    // pending or failed would mean scaling down a workload whose condition was
    // never confirmed. "waking" is the separate case of a wake that ran out of
    // budget and is handing the deployment back for a later retry.
    const mayReachHibernated = MCP_DEPLOYMENT_STATES.filter(
      (state) =>
        state !== "hibernated" &&
        isTransitionAllowed(state, "hibernated", "action"),
    );
    expect(mayReachHibernated.sort()).toEqual(["running", "waking"]);
  });

  test("waking is never entered directly from running", () => {
    // Waking means "we scaled a hibernated deployment back up". A running
    // deployment has nothing to wake from.
    expect(isTransitionAllowed("running", "waking", "action")).toBe(false);
  });

  test("nothing may be acted on from an unconfirmed state", () => {
    for (const from of [
      "not_created",
      "pending",
      "failed",
      "succeeded",
    ] as const) {
      expect(ALLOWED_ACTION_TRANSITIONS[from].size).toBe(0);
    }
  });
});

describe("observations", () => {
  test("any state may be observed from any state", () => {
    // An observation is a cluster read, or a confirmed transition mirrored
    // onto a sibling alias of the same physical Deployment. A fact cannot be
    // illegal, and a stale cached state must not be able to veto one — that
    // would leave one alias of a shared pod advertising a state the pod left.
    for (const from of MCP_DEPLOYMENT_STATES) {
      for (const to of MCP_DEPLOYMENT_STATES) {
        expect(isTransitionAllowed(from, to, "observation")).toBe(true);
      }
    }
  });

  test("an observation is allowed exactly where the same action is refused", () => {
    expect(isTransitionAllowed("failed", "hibernated", "action")).toBe(false);
    expect(isTransitionAllowed("failed", "hibernated", "observation")).toBe(
      true,
    );
  });
});

describe("assertTransition", () => {
  test("allows a legal action", () => {
    expect(
      assertTransition({
        from: "running",
        to: "hibernated",
        kind: "action",
        reason: "idle past window",
        deploymentName: "mcp-test",
      }),
    ).toBe(true);
  });

  test("refuses an illegal action instead of throwing", () => {
    // A mis-derived state must never take down a tool call; the next refresh
    // re-reads the cluster and converges.
    expect(
      assertTransition({
        from: "running",
        to: "waking",
        kind: "action",
        reason: "bogus",
        deploymentName: "mcp-test",
      }),
    ).toBe(false);
  });

  test("never refuses an observation", () => {
    expect(
      assertTransition({
        from: "running",
        to: "waking",
        kind: "observation",
        reason: "mirrored from a sibling alias",
        deploymentName: "mcp-test",
      }),
    ).toBe(true);
  });
});
