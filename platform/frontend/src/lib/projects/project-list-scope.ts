/**
 * The projects-list scope filter, mirroring the Agents page. Scope is the
 * project's share visibility: `personal` (private), `team` (shared with teams),
 * or `org` (org-wide). `all` is the default — everything the viewer can see.
 */
export const PROJECT_SCOPE_VALUES = ["all", "personal", "team", "org"] as const;

export type ProjectScopeValue = (typeof PROJECT_SCOPE_VALUES)[number];

/** Read a scope from a URL param, defaulting to `all` for missing/invalid. */
export function parseProjectScope(param: string | null): ProjectScopeValue {
  return PROJECT_SCOPE_VALUES.includes(param as ProjectScopeValue)
    ? (param as ProjectScopeValue)
    : "all";
}

/**
 * The API `scope` query value for a UI scope. `all` maps to `undefined` (no
 * filter) so it shares the unfiltered cache entry with the sidebar.
 */
export function toApiProjectScope(
  scope: ProjectScopeValue,
): "personal" | "team" | "org" | undefined {
  return scope === "all" ? undefined : scope;
}
