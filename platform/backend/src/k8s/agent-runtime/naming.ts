import { sanitizeLabelValue } from "@/k8s/shared";

/** The A2A task this pod carries — the pod's stable selector identity. */
export const AGENT_RUNTIME_TASK_LABEL = "archestra.io/agent-run-task-id";

/** The Agent Runtime definition the pod was launched from, for fleet-wide sweeps. */
const AGENT_RUNTIME_DEFINITION_LABEL = "archestra.io/agent-runtime-id";

/** Marks every object this runtime owns, for convergence sweeps and teardown. */
const AGENT_RUNTIME_PURPOSE_LABEL = "archestra.io/purpose";
const AGENT_RUNTIME_PURPOSE_VALUE = "agent-runtime";

export const AGENT_RUNTIME_LEASE_SCOPE = "agent-run-transition";

export function agentRuntimeNames(frozenName: string): {
  job: string;
  secret: string;
  networkPolicy: string;
  environmentNetworkPolicy: string;
} {
  return {
    job: frozenName,
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

/** Selector for the single pod carrying one task. */
export function agentRuntimePodSelector(taskId: string): string {
  return `${AGENT_RUNTIME_TASK_LABEL}=${taskId}`;
}
