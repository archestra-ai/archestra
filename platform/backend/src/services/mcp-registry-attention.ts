import {
  attentionRankTiers,
  canReauthenticateConnection,
  computeMcpServerIssues,
  isPermissionActionGranted,
  type Permissions,
} from "@archestra/shared";
import McpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import { McpServerAlertMuteModel, McpServerModel, TeamModel } from "@/models";
import InternalMcpCatalogModel, {
  type RegistryListOptions,
} from "@/models/internal-mcp-catalog";
import { projectMcpDeploymentStatuses } from "@/services/mcp-deployment-statuses";

/**
 * Every catalog item and install the viewer can see, reduced to what the issue
 * rule reads, with the viewer's own alert dismissals attached: the registry's
 * issue index, and the input of the server-side attention order.
 */
export async function loadRegistryIssueIndex(params: {
  options: RegistryListOptions & { userId: string; organizationId: string };
}) {
  const { options } = params;
  // The installs half follows GET /api/mcp_server's permission (the model
  // returns no rows for a viewer without it).
  const [catalogItems, servers] = await Promise.all([
    InternalMcpCatalogModel.findRegistryIssueIndex(options),
    McpServerModel.findIssueIndexRows({
      viewer: options.installViewer,
      organizationId: options.organizationId,
    }),
  ]);
  const alertMutes = await McpServerAlertMuteModel.findForViewer({
    userId: options.userId,
    catalogIds: catalogItems.map((item) => item.id),
  });
  return {
    catalogItems: catalogItems.map((item) => ({
      ...item,
      alertMutes: (alertMutes.get(item.id) ?? []).filter(
        (mute) => mute.mcpServerId === null,
      ),
    })),
    servers: servers.map((server) => ({
      ...server,
      alertMutes: server.catalogId
        ? (alertMutes.get(server.catalogId) ?? []).filter(
            (mute) => mute.mcpServerId === server.id,
          )
        : [],
    })),
  };
}

/**
 * The registry's "attention" order for one viewer, as rank tiers: the items
 * they must act on, then the items somebody else must. It is the browser's
 * issue rule (shared code) over the same inputs the browser reads — the issue
 * index and the runtime states the deployment feed pushes — with the viewer's
 * re-authentication and install-admin rights resolved here, so the first page
 * no longer waits for the browser to load the index and send the tiers.
 */
export async function computeRegistryAttentionTiers(params: {
  options: RegistryListOptions & { userId: string; organizationId: string };
  permissions: Permissions;
}): Promise<string[][]> {
  const { options, permissions } = params;
  const [index, teams] = await Promise.all([
    loadRegistryIssueIndex({ options }),
    // Direct memberships, as the browser's rule reads them (`/api/teams`
    // with `mine`): a parent team's member is not a member of its children.
    TeamModel.getUserTeamsForOrganization({
      userId: options.userId,
      organizationId: options.organizationId,
    }),
  ]);
  const isInstallsAdmin = options.isAdmin === true;
  const reauthViewer = {
    userId: options.userId,
    teamIds: new Set(teams.map((team) => team.id)),
    canCreate: isPermissionActionGranted({
      resource: "mcpServerInstallation",
      grantedActions: permissions.mcpServerInstallation ?? [],
      requiredAction: "create",
    }),
    canUpdate: isPermissionActionGranted({
      resource: "mcpServerInstallation",
      grantedActions: permissions.mcpServerInstallation ?? [],
      requiredAction: "update",
    }),
    isInstallsAdmin,
  };
  const issues = computeMcpServerIssues({
    items: index.catalogItems,
    servers: index.servers,
    deploymentStatuses: projectMcpDeploymentStatuses(
      McpServerRuntimeManager.statusSummary,
      index.servers.map((server) => server.id),
    ),
    viewer: {
      userId: options.userId,
      canManageInstalls: isInstallsAdmin,
      canReauthenticate: (server) =>
        canReauthenticateConnection({ server, viewer: reauthViewer }),
    },
  });
  return attentionRankTiers(issues);
}
