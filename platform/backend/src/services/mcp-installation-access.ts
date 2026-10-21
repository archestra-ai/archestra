import type { IncomingHttpHeaders } from "node:http";
import { hasPermission } from "@/auth";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import TeamModel from "@/models/team";
import { ApiError, type McpServer } from "@/types";

// Share the stable branch's existing connection lifecycle rules with OAuth.
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

export async function assertLifecycleRoutePermission(params: {
  headers: IncomingHttpHeaders;
  ordinaryAction: "create";
  verb: string;
}): Promise<void> {
  const [ordinary, admin] = await Promise.all([
    hasPermission(
      { mcpServerInstallation: [params.ordinaryAction] },
      params.headers,
    ),
    hasPermission({ mcpServerInstallation: ["admin"] }, params.headers),
  ]);
  if (ordinary.success || admin.success) return;
  throw new ApiError(
    403,
    `You do not have permission to ${params.verb} this MCP server`,
  );
}

export async function assertScopedLifecycleAuthorization(params: {
  mcpServer: {
    id: string;
    scope: "personal" | "team" | "org";
    ownerId: string | null;
    teamId: string | null;
  };
  userId: string;
  organizationId: string;
  headers: IncomingHttpHeaders;
  action: "revoke" | "re-authenticate" | "reinstall" | "reload tools for";
}): Promise<void> {
  const { mcpServer, userId, organizationId, headers, action } = params;

  switch (mcpServer.scope) {
    case "personal": {
      if (mcpServer.ownerId === userId) return;
      if (action === "revoke") {
        const { success: hasMcpServerUpdate } = await hasPermission(
          { mcpServerInstallation: ["update"] },
          headers,
        );
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
        !(await findMcpServerInOrganization(mcpServer.id, organizationId))
      ) {
        throw new ApiError(404, "MCP server not found");
      }
      const { success: canManageAllTeams } = await hasPermission(
        { team: ["create"] },
        headers,
      );
      if (canManageAllTeams) return;

      // Team deletion clears the FK but retains the connection. Global team
      // managers can still manage it; former team membership grants no access.
      if (!mcpServer.teamId) {
        throw new ApiError(
          403,
          `Only organization-level team managers can ${action} connections whose team was deleted`,
        );
      }

      const isLiteralTeamAdmin = await TeamModel.isUserTeamAdmin(
        mcpServer.teamId,
        userId,
      );
      if (isLiteralTeamAdmin) return;

      const { success: hasMcpServerUpdate } = await hasPermission(
        { mcpServerInstallation: ["update"] },
        headers,
      );
      if (!hasMcpServerUpdate) {
        throw new ApiError(
          403,
          `You don't have permission to ${action} team connections`,
        );
      }
      const isMember = await TeamModel.isUserInTeam(mcpServer.teamId, userId);
      if (!isMember) {
        throw new ApiError(
          403,
          `You can only ${action} connections for teams you are a member of`,
        );
      }
      return;
    }
    case "org": {
      const { success: isMcpServerInstallationAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        headers,
      );
      if (!isMcpServerInstallationAdmin) {
        throw new ApiError(
          403,
          `Only mcpServerInstallation admins can ${action} organization-scoped connections`,
        );
      }
      return;
    }
  }
}
