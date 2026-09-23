import type { QueryClient } from "@tanstack/react-query";

/**
 * The query keys of every read of the organization's policy: the text, what it
 * declares, what it composes to, the batteries, each catalog entry's matches,
 * the coverage it gives each tool and the GitHub source that may own the
 * text. A write to one moves the rest.
 */
export const guardrailsPolicyQueryKey = ["guardrails-policy"];
export const appaGithubSyncQueryKey = ["openappa-github-sync"];
export const batteriesQueryKey = ["openappa-batteries"];
export const policyDeclarationsQueryKey = ["openappa-policy-declarations"];
export const effectivePolicyQueryKey = ["openappa-effective-policy"];
export const batteryMatchesPrefix = "openappa-battery-matches";
/** Every coverage read: the summary and the paged servers, tools and agents. */
export const coverageQueryPrefix = "openappa-coverage";

export function invalidatePolicyViews(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: guardrailsPolicyQueryKey }),
    client.invalidateQueries({ queryKey: appaGithubSyncQueryKey }),
    client.invalidateQueries({ queryKey: batteriesQueryKey }),
    client.invalidateQueries({ queryKey: policyDeclarationsQueryKey }),
    client.invalidateQueries({ queryKey: effectivePolicyQueryKey }),
    client.invalidateQueries({ queryKey: [batteryMatchesPrefix] }),
    client.invalidateQueries({ queryKey: [coverageQueryPrefix] }),
  ]);
}
