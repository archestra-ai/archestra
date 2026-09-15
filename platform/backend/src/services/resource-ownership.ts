import { ARCHESTRA_MCP_CATALOG_ID, type Resource } from "@archestra/shared";
import { requireScopedModifyPermission } from "@/auth/agent-type-permissions";
import {
  getCatalogWriteMembershipTeamIds,
  requireMcpCatalogModifyPermission,
} from "@/auth/mcp-catalog-permissions";
import {
  getPermissionsForUserContext,
  isServiceAccountUserId,
} from "@/auth/utils";
import {
  A2aRemoteAgentModel,
  AppAccessModel,
  AppModel,
  InternalMcpCatalogModel,
  MemberModel,
  PluginModel,
  ProjectModel,
  SkillModel,
  TeamModel,
} from "@/models";
import A2aRemoteAgentTeamModel from "@/models/a2a-remote-agent-team";
import SkillTeamModel from "@/models/skill-team";
import { isBuiltInSkillSourceRef } from "@/skills/built-in-skills";
import { ApiError } from "@/types";
import { isUniqueConstraintError } from "@/utils/db";
import { assertNoStaticPinsBrokenByTargetChange } from "./agent-tool-assignment";

export async function transferResourceOwnership(params: {
  kind: "skill" | "plugin" | "project" | "app" | "catalog" | "remoteAgent";
  id: string;
  ownerId: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const { kind, id, ownerId, userId, organizationId } = params;
  const resource: Resource =
    kind === "catalog"
      ? "mcpRegistry"
      : kind === "remoteAgent"
        ? "agentSettings"
        : kind;
  const permissions = await getPermissionsForUserContext({
    userId,
    organizationId,
  });
  const actions = permissions[resource] ?? [];
  if (
    !actions.includes("update") ||
    (kind === "plugin" && !actions.includes("admin"))
  ) {
    throw new ApiError(
      403,
      "You do not have permission to transfer this resource",
    );
  }
  const entry = await loadResource(params);
  if (!entry || entry.row.organizationId !== organizationId)
    throw new ApiError(404, "Resource not found");
  const { row, authorId, teamIds, scope } = entry;
  if (
    authorId !== userId &&
    !(kind === "catalog"
      ? permissions.mcpServerInstallation?.includes("admin")
      : kind === "remoteAgent"
        ? actions.includes("update")
        : actions.includes("admin"))
  )
    throw new ApiError(
      403,
      "Only the owner or a resource admin can transfer ownership",
    );
  if (entry.managed)
    throw new ApiError(
      400,
      "Platform-managed resources cannot be transferred. Transfer apps from the Apps page.",
    );
  if (authorId === ownerId) throw new ApiError(400, "Choose a different owner");
  if (
    isServiceAccountUserId(ownerId) ||
    !(await MemberModel.getByUserId(ownerId, organizationId))
  )
    throw new ApiError(
      400,
      "The new owner must be a user in this organization",
    );
  const recipientPermissions = await getPermissionsForUserContext({
    userId: ownerId,
    organizationId,
  });
  const recipient = recipientPermissions[resource] ?? [];
  try {
    if (
      !recipient.includes("read") ||
      !recipient.includes("update") ||
      (kind === "plugin" && !recipient.includes("admin"))
    )
      throw new Error("Missing permissions");
    if (kind === "catalog" && "catalogTeams" in entry) {
      requireMcpCatalogModifyPermission({
        checker: {
          isAdmin:
            recipientPermissions.mcpServerInstallation?.includes("admin") ??
            false,
        },
        scope,
        authorId: ownerId,
        catalogTeams: entry.catalogTeams ?? [],
        writeMembershipTeamIds: await getCatalogWriteMembershipTeamIds(ownerId),
        userId: ownerId,
      });
    }
    if (kind !== "project" && kind !== "catalog" && kind !== "remoteAgent")
      requireScopedModifyPermission({
        isAdmin: recipient.includes("admin"),
        isTeamAdmin: recipient.includes("team-admin"),
        scope,
        authorId: ownerId,
        resourceTeamIds: teamIds,
        userTeamIds: await TeamModel.getUserTeamIds(ownerId),
        userId: ownerId,
        resourceLabel: "resource",
      });
  } catch {
    throw new ApiError(
      400,
      "The new owner needs permission to manage the resource at its current visibility",
    );
  }
  if (kind === "app") {
    const target = { organizationId, scope, authorId, teamIds };
    await assertNoStaticPinsBrokenByTargetChange({
      appId: id,
      currentTarget: target,
      nextTarget: { ...target, authorId: ownerId },
    });
  }
  try {
    const transferred = await entry.transfer({
      id,
      organizationId,
      previousOwnerId: authorId,
      updatedAt: row.updatedAt,
      ownerId,
    });
    if (!transferred)
      throw new ApiError(409, "The resource changed. Refresh and try again.");
  } catch (error) {
    if (isUniqueConstraintError(error))
      throw new ApiError(
        409,
        "The new owner already has a resource with this name. Rename it before transferring ownership.",
      );
    throw error;
  }
}

async function loadResource(params: {
  kind: "skill" | "plugin" | "project" | "app" | "catalog" | "remoteAgent";
  id: string;
  organizationId: string;
}) {
  const { kind, id, organizationId } = params;
  switch (kind) {
    case "skill": {
      const row = await SkillModel.findById(id);
      return (
        row && {
          row,
          authorId: row.authorId,
          scope: row.scope,
          teamIds: await SkillTeamModel.getTeamsForSkill(id),
          managed: !!row.sourceRef && isBuiltInSkillSourceRef(row.sourceRef),
          transfer: SkillModel.transferOwnership,
        }
      );
    }
    case "plugin": {
      const row = await PluginModel.findById({ id, organizationId });
      return (
        row && {
          row,
          authorId: row.authorId,
          scope: row.scope,
          teamIds: row.teams.map((t) => t.id),
          managed: false,
          transfer: PluginModel.transferOwnership,
        }
      );
    }
    case "project": {
      const row = await ProjectModel.findById(id);
      return (
        row && {
          row,
          authorId: row.userId,
          scope: "personal" as const,
          teamIds: [],
          managed: false,
          transfer: ProjectModel.transferOwnership,
        }
      );
    }
    case "app": {
      const row = await AppModel.findByIdInOrg(id, organizationId);
      return (
        row && {
          row,
          authorId: row.authorId,
          scope: row.scope,
          teamIds: await AppAccessModel.getTeamsForApp(id),
          managed: false,
          transfer: AppModel.transferOwnership,
        }
      );
    }
    case "catalog": {
      const row = await InternalMcpCatalogModel.findById(id, {
        organizationId,
        expandSecrets: false,
      });
      return (
        row && {
          row,
          authorId: row.authorId,
          scope: row.scope,
          teamIds: row.teams.map((t) => t.id),
          managed: id === ARCHESTRA_MCP_CATALOG_ID || row.serverType === "app",
          catalogTeams: row.teams,
          transfer: InternalMcpCatalogModel.transferOwnership,
        }
      );
    }
    case "remoteAgent": {
      const result = await A2aRemoteAgentModel.findByIdForOrganization({
        id,
        organizationId,
      });
      const row = result?.remoteAgent;
      const teams = await A2aRemoteAgentTeamModel.getDetailsForRemoteAgents([
        id,
      ]);
      return (
        row && {
          row,
          authorId: row.authorId,
          scope: row.scope,
          teamIds: (teams.get(id) ?? []).map((t) => t.id),
          managed: false,
          transfer: A2aRemoteAgentModel.transferOwnership,
        }
      );
    }
  }
}
