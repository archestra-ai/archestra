import type { McpDeploymentState } from "@archestra/shared";

/** Cluster facts used by the ordinary deployment lifecycle. */
export type OrdinaryDeploymentFacts = {
  exists: boolean;
  availableReplicas: number;
  podFailure: { failed: boolean; transient: boolean } | null;
};

/** Ordinary refresh outcomes. */
export type OrdinaryStateDecision =
  | { kind: "state"; state: McpDeploymentState }
  | { kind: "debounce-running" };

/** Derive ordinary missing, readiness, failure, and debounce state. */
export function deriveOrdinaryDeploymentState(
  facts: OrdinaryDeploymentFacts,
  cachedState: McpDeploymentState,
): OrdinaryStateDecision {
  if (!facts.exists) return { kind: "state", state: "not_created" };
  if (facts.availableReplicas > 0) {
    return { kind: "state", state: "running" };
  }
  if (facts.podFailure?.failed) {
    return {
      kind: "state",
      state: facts.podFailure.transient ? "pending" : "failed",
    };
  }
  if (cachedState === "running") return { kind: "debounce-running" };
  return { kind: "state", state: cachedState };
}

/** Cluster observations always replace cached state. */
export function applyDeploymentObservation({
  observedState,
}: {
  cachedState: McpDeploymentState;
  observedState: McpDeploymentState;
}): McpDeploymentState {
  return observedState;
}
