import type { QueryClient } from "@tanstack/react-query";

/**
 * The query keys of every read of the organization's policy: the text, what it
 * declares, what it composes to, the batteries, each catalog entry's matches,
 * the coverage it gives each tool, its trust and audience levels, its
 * remedies and the GitHub source that may own the text. A write to one moves
 * the rest.
 */
export const guardrailsPolicyQueryKey = ["guardrails-policy"];
export const appaGithubSyncQueryKey = ["openappa-github-sync"];
export const batteriesQueryKey = ["openappa-batteries"];
export const policyDeclarationsQueryKey = ["openappa-policy-declarations"];
export const effectivePolicyQueryKey = ["openappa-effective-policy"];
export const batteryMatchesPrefix = "openappa-battery-matches";
/** Every coverage read: visible policy targets and their tools. */
export const coverageQueryPrefix = "openappa-coverage";
export const trustAudienceQueryKey = ["openappa-trust-audience"];
export const remediesQueryKey = ["openappa-remedies"];

export function invalidatePolicyViews(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ["openappa-policy-tests"] }),
    client.invalidateQueries({ queryKey: ["openappa-policy-test-runs"] }),
    client.invalidateQueries({ queryKey: guardrailsPolicyQueryKey }),
    client.invalidateQueries({ queryKey: appaGithubSyncQueryKey }),
    client.invalidateQueries({ queryKey: batteriesQueryKey }),
    client.invalidateQueries({ queryKey: policyDeclarationsQueryKey }),
    client.invalidateQueries({ queryKey: effectivePolicyQueryKey }),
    client.invalidateQueries({ queryKey: [batteryMatchesPrefix] }),
    client.invalidateQueries({ queryKey: [coverageQueryPrefix] }),
    client.invalidateQueries({ queryKey: trustAudienceQueryKey }),
    client.invalidateQueries({ queryKey: remediesQueryKey }),
  ]);
}

const VALIDATION_ENTRY_PREFIX = "validation:";

/** The Policy page's entry for a validation file, as the URL carries it. */
export function validationEntry(path: string): string {
  return `${VALIDATION_ENTRY_PREFIX}${path}`;
}

/** The validation file an entry names; null for a policy file's entry. */
export function validationPathOf(entry: string | null): string | null {
  return entry?.startsWith(VALIDATION_ENTRY_PREFIX)
    ? entry.slice(VALIDATION_ENTRY_PREFIX.length)
    : null;
}

/** The Policy page opened directly to a validation file, or to the Policy root when none is named. */
export function validationPolicyHref(path?: string | null): string {
  if (!path) return "/openappa/policy";
  return `/openappa/policy?${new URLSearchParams({ entry: validationEntry(path) })}`;
}
