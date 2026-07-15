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
 * The policy the environment editor should seed when it opens, resolved to the
 * egress the backend actually enforces for the target so the control never reads
 * as more locked-down (or more open) than reality:
 * - an explicit policy → itself;
 * - a null policy, once the org query has resolved (`policyLoaded`), follows the
 *   backend's fall-through: a named environment inherits `orgDefaultPolicy`, and
 *   the org default (or a named env whose org default is also null) lands on the
 *   built-in unrestricted floor. So an env inheriting a restrictive default shows
 *   "restricted", and a genuinely open one shows "unrestricted" — never the
 *   reverse, which would mislabel an open environment as locked down;
 * - creating a new environment, or a null policy while the org query is still
 *   loading/failed → the locked-down "restricted" seed. A save never persists
 *   this seed on its own (see resolveNetworkPolicyUpdate — an untouched egress
 *   control is omitted), so it is safe against an unresolved query while it keeps
 *   a deliberate touch-then-save during load from widening a real default.
 */
export function resolveEditorDraftPolicy(params: {
  mode: "create" | "edit" | "default";
  policy: NetworkPolicy | null;
  orgDefaultPolicy: NetworkPolicy | null;
  policyLoaded: boolean;
}): NetworkPolicy {
  if (params.policy) return params.policy;
  if (params.mode === "create" || !params.policyLoaded) {
    return NEW_ENVIRONMENT_DEFAULT_POLICY;
  }
  return params.orgDefaultPolicy ?? BUILT_IN_NETWORK_POLICY;
}

/**
 * Decides what to send for `networkPolicy` in an environment save, as a partial
 * to spread into the mutation body. Creating always sends an explicit policy — a
 * new environment starts from a locked-down default. Editing an environment or
 * the org default only sends egress the user actually changed (`egressDirty`),
 * and only once the baseline the draft was seeded against is known: an explicit
 * stored policy (`originalPolicy`) is its own baseline, but a null one is seeded
 * from the org default, so its edit waits for `orgLoaded` — a dirty edit made
 * against a still-loading (or failed) org default is seeded from the locked-down
 * fallback, not the real effective policy, and persisting it could widen a
 * narrower real one. Otherwise the field is omitted, telling the backend to leave
 * the stored policy as-is — so a passive save (name-only, off a stale cache, or
 * against an unresolved baseline) never rewrites, widens, or clears the built-in
 * (`null`) sentinel; and an edit to an env's own explicit policy is never dropped
 * just because the unrelated org query is unavailable.
 */
export function resolveNetworkPolicyUpdate(params: {
  mode: "create" | "edit" | "default";
  egressDirty: boolean;
  originalPolicy: NetworkPolicy | null;
  orgLoaded: boolean;
  networkPolicy: NetworkPolicy;
}): { networkPolicy?: NetworkPolicy } {
  if (params.mode === "create") {
    return { networkPolicy: params.networkPolicy };
  }
  const baselineLoaded = params.originalPolicy !== null || params.orgLoaded;
  if (params.egressDirty && baselineLoaded) {
    return { networkPolicy: params.networkPolicy };
  }
  return {};
}

/**
 * Builds the network policy the editor would submit from its current form state.
 * The domain/preset fields carry whatever the draft was seeded with — the target's
 * effective (possibly inherited) policy — even while disabled because no FQDN
 * provider is available. Building domains straight from that form state means a
 * CIDR-only edit persists the existing allowlist rather than erasing rules the
 * form couldn't let the user re-enter. With no enforcer at all the whole egress
 * section is disabled, so persisting the default restricted + empty allowlists
 * would become a deny-all once an enforcer is installed — return the existing
 * policy (or a non-enforcing seed) instead.
 */
export function buildEditorNetworkPolicy(params: {
  enforcementUnavailable: boolean;
  egressMode: NetworkPolicy["egressMode"];
  domainPreset: NetworkPolicy["domainPreset"];
  allowedDomainsText: string;
  allowedCidrsText: string;
  originalPolicy: NetworkPolicy | null;
}): NetworkPolicy {
  if (params.enforcementUnavailable) {
    return params.originalPolicy ?? BUILT_IN_NETWORK_POLICY;
  }
  const restricted = params.egressMode === "restricted";
  return {
    egressMode: params.egressMode,
    domainPreset: restricted ? params.domainPreset : "none",
    allowedDomains: restricted
      ? splitPolicyList(params.allowedDomainsText)
      : [],
    allowedCidrs: restricted ? splitPolicyList(params.allowedCidrsText) : [],
  };
}

function splitPolicyList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}
