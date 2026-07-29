import type { ResourceVisibilityScope } from "@archestra/shared";

// A project's share visibility, as returned on each project list item. `null`
// means the project is personal (unshared, owner-only) — the API types it as
// non-nullable, but the value is null at runtime for personal projects.
export type ProjectVisibility = "organization" | "team" | "user" | null;

/**
 * Maps a project's share visibility to the scope language shared across the app
 * (personal / team / org), so it can drive the shared `ScopeBadge`. The label
 * (including team names) is built by `ScopeBadge` itself.
 */
export function projectVisibilityToScope(
  visibility: ProjectVisibility,
): ResourceVisibilityScope {
  if (visibility === "organization") return "org";
  if (visibility === "team") return "team";
  // A project shared with named people stays `personal` in scope language; the
  // badge distinguishes it from a private one through the grantee names it is
  // given, exactly as an app shared that way does.
  return "personal";
}
