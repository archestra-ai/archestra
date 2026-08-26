import {
  ensureStringIsRfc1123Compliant,
  sanitizeLabelValue,
} from "@/k8s/shared";

/** Label carrying the runner's id; the only selector-stable identity a pod has. */
export const RUNNER_ID_LABEL = "archestra.io/runner-id";

/** Marks every object this runtime owns, for convergence sweeps and teardown. */
const RUNNER_PURPOSE_LABEL = "archestra.io/purpose";
const RUNNER_PURPOSE_VALUE = "runner";

export const RUNNER_LEASE_SCOPE = "runner-transition";

/** Selector matching every runner object in a namespace. */
export const RUNNER_MANAGED_SELECTOR = `${RUNNER_PURPOSE_LABEL}=${RUNNER_PURPOSE_VALUE}`;

/**
 * Frozen Kubernetes names for one runner: `runner-<slug40>-<id8>`.
 *
 * Computed once at creation, stored on the row, and never recomputed —
 * workload identity must not follow the mutable display name, or a rename
 * orphans the running session. The 53-char cap leaves room for the derived
 * `-secret` / `-np` suffixes inside the 63-char RFC 1123 label limit.
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
export function runnerLabels(runnerId: string): Record<string, string> {
  // Only the values go through the sanitizer: a Kubernetes label key may carry
  // a DNS prefix, and `sanitizeMetadataLabels` strips the "/" that separates
  // it, silently turning `archestra.io/runner-id` into a different key.
  return {
    app: "archestra-runner",
    [RUNNER_PURPOSE_LABEL]: RUNNER_PURPOSE_VALUE,
    [RUNNER_ID_LABEL]: sanitizeLabelValue(runnerId),
  };
}

/** Selector for the single pod belonging to one runner. */
export function runnerPodSelector(runnerId: string): string {
  return `${RUNNER_ID_LABEL}=${runnerId}`;
}
