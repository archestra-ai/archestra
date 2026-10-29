import { sanitizeLabelValue } from "@/k8s/shared";

/** The A2A task this pod carries — the pod's stable selector identity. */
export const AGENT_RUNTIME_TASK_LABEL = "archestra.io/agent-run-task-id";
export const AGENT_RUNTIME_WORKSPACE_LABEL = "archestra.io/agent-workspace";

/** The Agent Runtime definition the pod was launched from, for fleet-wide sweeps. */
const AGENT_RUNTIME_DEFINITION_LABEL = "archestra.io/agent-runtime-id";

/** Marks every object this runtime owns, for convergence sweeps and teardown. */
const AGENT_RUNTIME_PURPOSE_LABEL = "archestra.io/purpose";
const AGENT_RUNTIME_PURPOSE_VALUE = "agent-runtime";

export const AGENT_RUNTIME_LEASE_SCOPE = "agent-run-transition";
/**
 * One tier switch per run. Not the session lease: a run adopted after a
 * control-plane restart holds that one for its whole turn.
 */
export const AGENT_RUNTIME_TIER_SWITCH_LEASE_SCOPE = "agent-run-tier-switch";

/** Sandbox annotation: the tier its Pod template runs, when the Agent has tiers. */
export const AGENT_RUNTIME_TIER_ANNOTATION = "archestra.io/agent-runtime-tier";
/**
 * Sandbox annotation: the task whose turn a tier switch stopped. Present from
 * just before the switch suspends the Sandbox until its replacement Pod runs,
 * so recovery after a control-plane restart can finish waking it.
 */
export const AGENT_RUNTIME_TIER_SWITCH_ANNOTATION =
  "archestra.io/agent-runtime-tier-switch";

export function agentRuntimeNames(frozenName: string): {
  sandbox: string;
  secret: string;
  networkPolicy: string;
  environmentNetworkPolicy: string;
} {
  return {
    sandbox: frozenName,
    secret: `${frozenName}-env`,
    networkPolicy: `${frozenName}-np`,
    environmentNetworkPolicy: `${frozenName}-egress`,
  };
}

/**
 * Labels every Agent Runtime object carries.
 *
 * Deliberately excludes the display name: an AND-semantics selector keyed on a
 * mutable value matches zero pods, and a pod no policy selects falls through to
 * the namespace deny-all baseline with no egress at all — DNS included.
 */
export function agentRuntimeLabels(params: {
  taskId: string;
  agentRuntimeId: string;
}): Record<string, string> {
  // Only the values go through the sanitizer: a Kubernetes label key may carry
  // a DNS prefix, and `sanitizeMetadataLabels` strips the "/" that separates
  // it, silently turning `archestra.io/agent-runtime-id` into a different key.
  return {
    app: "archestra-agent-runtime",
    [AGENT_RUNTIME_PURPOSE_LABEL]: AGENT_RUNTIME_PURPOSE_VALUE,
    [AGENT_RUNTIME_TASK_LABEL]: sanitizeLabelValue(params.taskId),
    [AGENT_RUNTIME_DEFINITION_LABEL]: sanitizeLabelValue(params.agentRuntimeId),
  };
}
