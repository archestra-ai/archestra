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
 * The policy the environment editor should seed when it opens, matching what the
 * backend actually resolves and enforces for that target:
 * - an explicit policy → itself;
 * - creating a new environment → the locked-down default;
 * - an existing environment with no policy → the org default it inherits, else
 *   the built-in unrestricted floor;
 * - the org-default editor with no policy → the built-in unrestricted floor.
 */
export function resolveEditorDraftPolicy(params: {
  mode: "create" | "edit" | "default";
  policy: NetworkPolicy | null;
  orgDefaultPolicy: NetworkPolicy | null;
}): NetworkPolicy {
  if (params.policy) return params.policy;
  if (params.mode === "create") return NEW_ENVIRONMENT_DEFAULT_POLICY;
  if (params.mode === "default") return BUILT_IN_NETWORK_POLICY;
  return params.orgDefaultPolicy ?? BUILT_IN_NETWORK_POLICY;
}
