import type { EnvironmentWithAssignedCount } from "@/lib/environment.query";

type NetworkPolicy = NonNullable<EnvironmentWithAssignedCount["networkPolicy"]>;

// Draft seed when creating a *new* environment — a safe, locked-down starting point.
const NEW_ENVIRONMENT_DEFAULT_POLICY: NetworkPolicy = {
  egressMode: "restricted",
  domainPreset: "none",
  allowedDomains: [],
  allowedCidrs: [],
};

// Draft seed for an environment (or the org default) with no explicit policy. The
// backend treats a null/built-in policy as unrestricted — the SSRF floor: public
// egress with reserved ranges blocked — so the editor must show that. Seeding
// "restricted" here would mislabel an open environment as locked down.
const BUILT_IN_NETWORK_POLICY: NetworkPolicy = {
  egressMode: "unrestricted",
  domainPreset: "none",
  allowedDomains: [],
  allowedCidrs: [],
};

/**
 * The policy the environment editor should seed when it opens, chosen to match
 * what the backend enforces while never seeding — and letting a save persist —
 * open egress it can't confirm:
 * - an explicit policy → itself;
 * - the org-default editor whose policy is *known* absent (`policyLoaded`, i.e.
 *   the org query has resolved) → the built-in unrestricted floor the backend
 *   enforces for a null policy;
 * - everything else — creating a new environment, editing a named one, or the
 *   org default not yet loaded/failed — → the locked-down "restricted" default,
 *   so an unresolved query can never widen a restrictive policy to open egress.
 */
export function resolveEditorDraftPolicy(params: {
  mode: "create" | "edit" | "default";
  policy: NetworkPolicy | null;
  policyLoaded: boolean;
}): NetworkPolicy {
  if (params.policy) return params.policy;
  if (params.mode === "default" && params.policyLoaded) {
    return BUILT_IN_NETWORK_POLICY;
  }
  return NEW_ENVIRONMENT_DEFAULT_POLICY;
}
