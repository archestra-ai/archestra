import type { IncomingHttpHeaders } from "node:http";
import { hasPermission } from "@/auth";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import TeamModel from "@/models/team";
import { ApiError, type McpServer } from "@/types";

export async function findMcpServerInOrganization(
  id: string,
  organizationId: string,
): Promise<McpServer | null> {
  const server = await McpServerModel.findByIdInOrg(id, organizationId);
  if (!server) return null;
  const catalog = await InternalMcpCatalogModel.findById(server.catalogId, {
    expandSecrets: false,
  });
  if (catalog?.organizationId && catalog.organizationId !== organizationId) {
    return null;
  }
  return server;
}

/**
 * Re-authentication repeats the route-level capability check because it
 * replaces credentials. Installation admin subsumes create permission.
 */
export async function assertLifecycleRoutePermission(params: {
  headers: IncomingHttpHeaders;
  userId: string;
  organizationId: string;
  ordinaryAction: "create";
  verb: string;
}): Promise<void> {
  const [ordinary, admin] = await Promise.all([
    hasPermission(
      { mcpServerInstallation: [params.ordinaryAction] },
      params.headers,
    ),
    isMcpInstallationAdmin(params),
  ]);
  if (ordinary.success || admin) return;
  throw new ApiError(
    403,
    `You do not have permission to ${params.verb} this MCP server`,
  );
}

/**
 * Gate connection lifecycle actions (revoke / restore / reauth / reinstall)
 * on an already-fetched MCP server by its scope. Rules:
 *   - personal:
 *       - revoke / restore: owner OR mcpServerInstallation:update
 *       - re-authenticate / reinstall: owner only (these replace the
 *         connection's secret, so they must not be available to editors)
 *   - team:     mcpServerInstallation:admin OR (mcpServerInstallation:update AND user-in-team)
 *   - org:      mcpServerInstallation:admin (no owner fallback)
 */
export async function assertScopedLifecycleAuthorization(params: {
  mcpServer: {
    id: string;
    scope: "personal" | "team" | "org";
    ownerId: string | null;
    teamId: string | null;
    deletedAt?: Date | null;
  };
  userId: string;
  organizationId: string;
  headers: IncomingHttpHeaders;
  action:
    | "revoke"
    | "restore"
    | "re-authenticate"
    | "reinstall"
    | "reload tools for";
  authorization?: { isAdmin: boolean; canUpdate: boolean; teamIds: string[] };
}): Promise<void> {
  const { mcpServer, userId, organizationId, headers, action } = params;

  switch (mcpServer.scope) {
    case "personal": {
      if (mcpServer.ownerId === userId) return;
      if (action === "revoke" || action === "restore") {
        const hasMcpServerUpdate =
          params.authorization?.canUpdate ??
          (await hasPermission({ mcpServerInstallation: ["update"] }, headers))
            .success;
        if (hasMcpServerUpdate) return;
        throw new ApiError(
          403,
          `Only the connection owner or an editor/admin can ${action} personal connections`,
        );
      }
      throw new ApiError(
        403,
        `Only the connection owner can ${action} personal connections`,
      );
    }
    case "team": {
      // A deleted team no longer supplies an organization link. Resolve the
      // retained connection through its owner and catalog before granting access.
      if (
        !mcpServer.teamId &&
        !(mcpServer.deletedAt
          ? await McpServerModel.findDeletedByIdForOrganization(
              mcpServer.id,
              organizationId,
            )
          : await findMcpServerInOrganization(mcpServer.id, organizationId))
      ) {
        throw new ApiError(404, "MCP server not found");
      }
      if (
        params.authorization?.isAdmin ??
        (await isMcpInstallationAdmin({ userId, organizationId }))
      )
        return;

      // Team deletion clears the FK but retains the connection. Installation
      // admins can still manage it; former team membership grants no access.
      if (!mcpServer.teamId) {
        throw new ApiError(
          403,
          `Only installation admins can ${action} connections whose team was deleted`,
        );
      }

      const hasMcpServerUpdate =
        params.authorization?.canUpdate ??
        (await hasPermission({ mcpServerInstallation: ["update"] }, headers))
          .success;
      if (!hasMcpServerUpdate) {
        throw new ApiError(
          403,
          `You don't have permission to ${action} team connections`,
        );
      }
      const isMember = params.authorization
        ? params.authorization.teamIds.includes(mcpServer.teamId)
        : await TeamModel.isUserInTeam(mcpServer.teamId, userId);
      if (!isMember) {
        throw new ApiError(
          403,
          `You can only ${action} connections for teams you are a member of`,
        );
      }
      return;
    }
    case "org": {
      if (
        !(
          params.authorization?.isAdmin ??
          (await isMcpInstallationAdmin({ userId, organizationId }))
        )
      ) {
        throw new ApiError(
          403,
          `Only mcpServerInstallation admins can ${action} organization-scoped connections`,
        );
      }
      return;
    }
  }
}
