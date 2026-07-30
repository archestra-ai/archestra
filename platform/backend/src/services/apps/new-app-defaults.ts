import { OrganizationModel } from "@/models";

/**
 * The organization's lifecycle defaults for a newly created app, applied at
 * creation time by both create paths (REST create and the scaffold_app MCP
 * tool). "New apps are disabled by default" creates the app author-only;
 * "New apps are locked by default" creates it immutable to agents until a
 * user unlocks it. Flipping either setting never touches existing apps.
 */
export async function resolveNewAppLifecycleDefaults(
  organizationId: string,
): Promise<{ enabled: boolean; locked: boolean }> {
  const organization = await OrganizationModel.getById(organizationId);
  return {
    enabled: !(organization?.newAppsDisabledByDefault ?? false),
    locked: organization?.newAppsLockedByDefault ?? false,
  };
}
