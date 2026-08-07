// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import type { McpDeploymentState } from "@archestra/shared";
import logger from "@/logging";

/**
 * The hibernation lifecycle, as one explicit machine.
 *
 * Two things live here and nowhere else: how a deployment's state is DERIVED
 * from cluster facts, and which transitions between states are LEGAL. Before
 * this module both were spread across ~25 assignment sites in k8s-deployment.ts
 * with no validation, which is how a stale status refresh could quietly
 * overwrite a hibernate, and how a cache-cold alias could be read as "awake".
 *
 * Derivation is a total function of cluster facts. Transition legality is a
 * table. Neither touches Kubernetes or the database, so the whole correctness
 * argument for the feature is unit-testable without a cluster.
 */

/**
 * Everything about a Deployment that the state derivation is allowed to look
 * at. Deliberately a plain record rather than the K8s object: it keeps the
 * truth table honest (nothing can sneak in another input) and makes every row
 * of it expressible in a test as three numbers and two booleans.
 */
export type DeploymentFacts = {
  /** False when the Deployment does not exist in the cluster at all. */
  exists: boolean;
  /** Our ownership marker — see {@link MCP_HIBERNATED_ANNOTATION}. */
  hasHibernationAnnotation: boolean;
  /** `spec.replicas`, i.e. the desired count. */
  replicas: number;
  /** `status.availableReplicas`, i.e. what is actually serving. */
  availableReplicas: number;
  /**
   * A terminal container failure, if the pod reports one. `transient` marks
   * the kinds the kubelet retries on its own (image pulls), which must not
   * latch a deployment into "failed".
   */
  podFailure: { failed: boolean; transient: boolean } | null;
};

/**
 * What a refresh should do with a set of facts. Not simply a state, because
 * two outcomes are not states: an available deployment still carrying the
 * annotation needs its wake FINISHED before it can be called running, and a
 * running deployment that momentarily reports nothing available must be
 * debounced rather than believed.
 */
type StateDecision =
  /** Adopt this state directly. */
  | { kind: "state"; state: McpDeploymentState }
  /**
   * Annotation present, replicas up, and available: a wake whose final patch
   * never landed (or whose process died). Drop the annotations, then running.
   */
  | { kind: "finish-wake" }
  /**
   * Cached "running" but nothing available right now. Almost always K8s API
   * lag, so count the miss and only downgrade after several in a row.
   */
  | { kind: "debounce-running" };

/**
 * Derive the state a deployment is in from what the cluster says about it.
 *
 * The ordering is the whole design: the annotation is checked FIRST, because
 * it is what distinguishes "we scaled this to zero" from "somebody else did".
 * Only once we know the deployment is not ours-and-asleep do the ordinary
 * availability and failure rules apply.
 */
export function deriveDeploymentState(
  facts: DeploymentFacts,
  cachedState: McpDeploymentState,
): StateDecision {
  if (!facts.exists) return { kind: "state", state: "not_created" };

  if (facts.hasHibernationAnnotation) {
    // Ours, asleep. A zero-replica deployment is never "available", so without
    // this branch it would degrade through the debounce into a permanent
    // "pending" and look broken rather than idle.
    if (facts.replicas === 0) return { kind: "state", state: "hibernated" };
    if (facts.availableReplicas > 0) return { kind: "finish-wake" };
    // Scaled up with the marker still on it: mid-wake. An expected, calm few
    // seconds — never an error.
    return { kind: "state", state: "waking" };
  }

  // No marker. Anything below is the ordinary deployment lifecycle.
  if (facts.availableReplicas > 0) return { kind: "state", state: "running" };

  if (facts.podFailure?.failed) {
    // Image pulls self-heal on the kubelet's own backoff; latching "failed"
    // here would demand a manual restart for something already recovering.
    return {
      kind: "state",
      state: facts.podFailure.transient ? "pending" : "failed",
    };
  }

  if (cachedState === "running") return { kind: "debounce-running" };

  if (cachedState === "hibernated" || cachedState === "waking") {
    // The marker is gone but we still think we are holding this asleep — an
    // operator removed it, or another replica finished the wake. It is not
    // ours to hold anymore, and no other branch can reach these states, so
    // without this they would stick forever.
    return { kind: "state", state: "pending" };
  }

  return { kind: "state", state: cachedState };
}

/**
 * Why a state is changing. The distinction is load-bearing, and getting it
 * wrong was the first thing the tests here caught.
 *
 * An ACTION is this process deciding to change the world — scale to zero,
 * scale back up, drop the annotations. Those are the moves worth constraining,
 * because an unexpected one means a caller reasoned from a state it should not
 * have been in, and the consequence is a workload scaled the wrong way.
 *
 * An OBSERVATION is this process learning what the world already is — a
 * cluster read, or a confirmed transition mirrored onto a sibling alias of the
 * same physical Deployment. A fact cannot be illegal, and a stale cached state
 * must never be allowed to veto one.
 */
export type TransitionKind = "action" | "observation";

/**
 * The moves this process may PERFORM, and the entire hibernation lifecycle.
 * Anything not listed is a bug in the caller.
 *
 * Read it as the three lifecycle primitives plus their failure exits:
 *   running     --hibernate--->    hibernated
 *   hibernated  --beginWake--->    waking
 *   waking      --completeWake-->  running
 *   waking      --out of budget->  hibernated   (retryable, marker kept)
 *   waking      --pod broken---->  failed       (terminal, lifecycle owns it)
 *
 * @public — the table is the contract; its own tests enumerate every cell
 */
export const ALLOWED_ACTION_TRANSITIONS: Record<
  McpDeploymentState,
  ReadonlySet<McpDeploymentState>
> = {
  running: new Set(["hibernated"]),
  hibernated: new Set(["waking"]),
  waking: new Set(["running", "hibernated", "failed"]),
  // Nothing may be acted on from a state whose condition we never confirmed.
  // Notably: a deployment cannot be put to sleep from "pending" or "failed" —
  // the sweeper must see it serving first.
  not_created: new Set([]),
  pending: new Set([]),
  failed: new Set([]),
  succeeded: new Set([]),
};

/** @public — the table's predicate form, exercised directly by its tests */
export function isTransitionAllowed(
  from: McpDeploymentState,
  to: McpDeploymentState,
  kind: TransitionKind = "action",
): boolean {
  // Re-entering the current state is always legal and always a no-op. This is
  // what makes every lifecycle operation idempotent: hibernating an already
  // hibernated deployment is a legal nothing, not a refused move.
  if (from === to) return true;
  if (kind === "observation") return true;
  return ALLOWED_ACTION_TRANSITIONS[from].has(to);
}

/**
 * Gate every state mutation. Returns whether the caller should apply it.
 *
 * An illegal transition is refused and logged rather than thrown: a
 * mis-derived state must never take down a tool call, and the next refresh
 * re-reads the cluster and converges anyway.
 */
export function assertTransition(params: {
  from: McpDeploymentState;
  to: McpDeploymentState;
  kind: TransitionKind;
  reason: string;
  deploymentName: string;
}): boolean {
  const { from, to, kind, reason, deploymentName } = params;
  if (isTransitionAllowed(from, to, kind)) return true;
  logger.warn(
    { from, to, kind, reason, deploymentName },
    "Refused an illegal MCP hibernation state transition",
  );
  return false;
}
