/** A project's relationship to the viewer, as returned by the projects API. */
export type ProjectViewerRole = "owner" | "shared" | "admin";

/**
 * Whether the viewer may manage a project — edit its details, sharing, and
 * instructions, or delete it. Mirrors the backend's `requireManageable`: the
 * owner always can, and a `project:admin` can manage ANY project they can see
 * (one shared with them, or another member's they oversee), since `project:admin`
 * is full oversight. A plain "shared" recipient without `project:admin` cannot.
 *
 * (`viewerRole === "admin"` already implies the caller holds `project:admin`, so
 * it stays manageable even before the permission query resolves.)
 */
export function canManageProject(
  viewerRole: ProjectViewerRole,
  isProjectAdmin: boolean,
): boolean {
  return viewerRole === "owner" || viewerRole === "admin" || isProjectAdmin;
}
