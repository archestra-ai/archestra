/**
 * The projects-list scope filter (mirrors the Agents page personal/shared
 * filter). `all` is the default view (own + shared); `others` is the admin-only
 * oversight view of other members' projects.
 */
export const PROJECT_SCOPE_VALUES = [
  "all",
  "personal",
  "shared",
  "others",
] as const;

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
): "personal" | "shared" | "others" | undefined {
  return scope === "all" ? undefined : scope;
}

/**
 * Pinned grouping applies only where projects are pinnable to the viewer. The
 * admin "Other users" oversight list is shown flat — no pinned grouping, no pin
 * action (those projects can't be pinned and aren't the viewer's own).
 */
export function scopeUsesPinnedGrouping(scope: ProjectScopeValue): boolean {
  return scope !== "others";
}
