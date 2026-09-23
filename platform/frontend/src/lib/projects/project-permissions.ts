/** A project's relationship to the viewer, as returned by the projects API. */
export type ProjectViewerRole = "owner" | "shared" | "admin";

/**
 * Whether the viewer may manage a project — edit its details, sharing, and
 * instructions, or delete it. Mirrors the backend's `requireManageable`: the
 * owner always can, and an overseer of every project (`update` at `*`) can
 * manage ANY project they can see. A plain "shared" recipient cannot.
 *
 * (`viewerRole === "admin"` already implies that oversight, so it stays
 * manageable even before the permission query resolves.)
 */
export function canManageProject(
  viewerRole: ProjectViewerRole,
  isProjectAdmin: boolean,
): boolean {
  return viewerRole === "owner" || viewerRole === "admin" || isProjectAdmin;
}

/**
 * Whether the viewer may delete a project. Deleting follows manageability,
 * mirroring the backend, which decides it by the project's `delete` grant.
 */
export function canDeleteProject(params: {
  viewerRole: ProjectViewerRole;
  isProjectAdmin: boolean;
}): boolean {
  return canManageProject(params.viewerRole, params.isProjectAdmin);
}
