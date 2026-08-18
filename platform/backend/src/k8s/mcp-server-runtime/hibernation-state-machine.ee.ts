// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import type { McpDeploymentState } from "@archestra/shared";
import logger from "@/logging";
import {
  deriveOrdinaryDeploymentState,
  type OrdinaryDeploymentFacts,
  type OrdinaryStateDecision,
} from "./hibernation-state-machine";

export {
  MCP_FOREIGN_REPLICA_OWNER_ANNOTATION,
  MCP_HIBERNATED_ANNOTATION,
  MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION,
} from "@/k8s/shared";

type DeploymentFacts = OrdinaryDeploymentFacts & {
  hasHibernationAnnotation: boolean;
  replicas: number;
};

type StateDecision =
  | OrdinaryStateDecision
  | {
      kind: "finish-wake";
    };

/** @public - action table is the hibernation lifecycle contract. */
export const ALLOWED_ACTION_TRANSITIONS: Record<
  McpDeploymentState,
  ReadonlySet<McpDeploymentState>
> = {
  running: new Set(["hibernated"]),
  hibernated: new Set(["waking"]),
  waking: new Set(["running", "hibernated", "failed"]),
  not_created: new Set([]),
  pending: new Set([]),
  failed: new Set([]),
  succeeded: new Set([]),
};

/** Add marker-owned hibernation states to ordinary deployment derivation. */
export function deriveDeploymentState(
  facts: DeploymentFacts,
  cachedState: McpDeploymentState,
): StateDecision {
  if (!facts.exists) {
    return deriveOrdinaryDeploymentState(facts, cachedState);
  }

  if (facts.hasHibernationAnnotation) {
    if (facts.replicas === 0) {
      return { kind: "state", state: "hibernated" };
    }
    if (facts.availableReplicas > 0) return { kind: "finish-wake" };
    if (facts.podFailure?.failed && !facts.podFailure.transient) {
      return { kind: "state", state: "failed" };
    }
    return { kind: "state", state: "waking" };
  }

  const ordinaryDecision = deriveOrdinaryDeploymentState(facts, cachedState);
  if (
    ordinaryDecision.kind === "state" &&
    (ordinaryDecision.state === "hibernated" ||
      ordinaryDecision.state === "waking")
  ) {
    return { kind: "state", state: "pending" };
  }
  return ordinaryDecision;
}

/** @public - predicate form of the action transition table. */
export function isActionTransitionAllowed(
  from: McpDeploymentState,
  to: McpDeploymentState,
): boolean {
  if (from === to) return true;
  return ALLOWED_ACTION_TRANSITIONS[from].has(to);
}

/** Refuse and log illegal hibernation actions without throwing. */
export function assertActionTransition(params: {
  from: McpDeploymentState;
  to: McpDeploymentState;
  reason: string;
  deploymentName: string;
}): boolean {
  const { from, to, reason, deploymentName } = params;
  if (isActionTransitionAllowed(from, to)) return true;
  logger.warn(
    { from, to, kind: "action", reason, deploymentName },
    "Refused an illegal MCP hibernation state transition",
  );
  return false;
}
