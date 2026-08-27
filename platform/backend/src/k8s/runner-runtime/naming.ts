import {
  ensureStringIsRfc1123Compliant,
  sanitizeLabelValue,
} from "@/k8s/shared";

/** The A2A task this pod carries — the pod's stable selector identity. */
export const RUNNER_TASK_LABEL = "archestra.io/runner-task-id";

/** The runner definition the pod was launched from, for fleet-wide sweeps. */
const RUNNER_DEFINITION_LABEL = "archestra.io/runner-id";

/** Marks every object this runtime owns, for convergence sweeps and teardown. */
const RUNNER_PURPOSE_LABEL = "archestra.io/purpose";
const RUNNER_PURPOSE_VALUE = "runner";

export const RUNNER_LEASE_SCOPE = "runner-transition";

/**
 * Frozen Kubernetes names for one runner: `runner-<slug40>-<id8>`.
 *
 * Computed once at creation, stored on the row, and never recomputed —
 * workload identity must not follow the mutable display name, or a rename
 * orphans the running session. The 56-char cap leaves room for the derived
 * `-env` / `-np` suffixes inside the 63-char RFC 1123 label limit.
 */
export function constructFrozenRunnerName(name: string, id: string): string {
  const slug =
    ensureStringIsRfc1123Compliant(name)
      .slice(0, 40)
      .replace(/[^a-z0-9]+$/, "") || "session";
  return `runner-${slug}-${id.slice(0, 8)}`;
}

export function runnerNames(frozenName: string): {
  job: string;
  secret: string;
  networkPolicy: string;
} {
  return {
    job: frozenName,
    secret: `${frozenName}-env`,
    networkPolicy: `${frozenName}-np`,
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
