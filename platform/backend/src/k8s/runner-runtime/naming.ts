import { sanitizeLabelValue } from "@/k8s/shared";

/** The A2A task this pod carries — the pod's stable selector identity. */
export const RUNNER_TASK_LABEL = "archestra.io/runner-task-id";

/** The runner definition the pod was launched from, for fleet-wide sweeps. */
const RUNNER_DEFINITION_LABEL = "archestra.io/runner-id";

/** Marks every object this runtime owns, for convergence sweeps and teardown. */
const RUNNER_PURPOSE_LABEL = "archestra.io/purpose";
const RUNNER_PURPOSE_VALUE = "runner";

export const RUNNER_LEASE_SCOPE = "runner-transition";

export function runnerNames(frozenName: string): {
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
 * Labels every runner object carries.
 *
 * Deliberately excludes the display name: an AND-semantics selector keyed on a
 * mutable value matches zero pods, and a pod no policy selects falls through to
 * the namespace deny-all baseline with no egress at all — DNS included.
 */
export function runnerLabels(params: {
  taskId: string;
  runnerId: string;
}): Record<string, string> {
  // Only the values go through the sanitizer: a Kubernetes label key may carry
  // a DNS prefix, and `sanitizeMetadataLabels` strips the "/" that separates
  // it, silently turning `archestra.io/runner-id` into a different key.
  return {
    app: "archestra-runner",
    [RUNNER_PURPOSE_LABEL]: RUNNER_PURPOSE_VALUE,
    [RUNNER_TASK_LABEL]: sanitizeLabelValue(params.taskId),
    [RUNNER_DEFINITION_LABEL]: sanitizeLabelValue(params.runnerId),
  };
}

/** Selector for the single pod carrying one task. */
export function runnerPodSelector(taskId: string): string {
  return `${RUNNER_TASK_LABEL}=${taskId}`;
}
