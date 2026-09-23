import {
  ARCHESTRA_MCP_CATALOG_ID,
  type Resource,
  type ScopedResource,
} from "@archestra/shared";
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
} from "@/models";
import A2aRemoteAgentTeamModel from "@/models/a2a-remote-agent-team";
import SkillTeamModel from "@/models/skill-team";
import { isBuiltInSkillSourceRef } from "@/skills/built-in-skills";
import { ApiError } from "@/types";
import { isUniqueConstraintError } from "@/utils/db";
import { assertNoStaticPinsBrokenByTargetChange } from "./agent-tool-assignment";
import { ResourcePermissions } from "./resource-permissions";

export async function transferResourceOwnership(params: {
  kind: "skill" | "plugin" | "project" | "app" | "catalog" | "remoteAgent";
  id: string;
  ownerId: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const { kind, id, ownerId, userId, organizationId } = params;
  const scoped = SCOPED_RESOURCE_KINDS[kind];
  if (scoped) {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // A 403 before the row is loaded would disclose nothing; the scoped check
    // itself answers 404 for a foreign or missing object.
    await ResourcePermissions.authorizeOwnershipTransfer({
      organizationId,
      userId,
      resource: scoped,
      scope: id,
      ownerId,
    });
    // SPDX-SnippetEnd
  } else {
    const resource = LEGACY_RESOURCE_FOR_KIND[kind];
    const permissions = await getPermissionsForUserContext({
      userId,
      organizationId,
    });
    const actions = permissions[resource] ?? [];
    if (
      !actions.includes("update") ||
      (kind === "plugin" &&
        !(await managesEveryObject({ kind, userId, organizationId })))
    ) {
      throw new ApiError(
        403,
        "You do not have permission to transfer this resource",
      );
    }
  }
  const entry = await loadResource(params);
  if (!entry || entry.row.organizationId !== organizationId)
    throw new ApiError(404, "Resource not found");
  const { row, authorId, teamIds, scope } = entry;
  if (!scoped) {
    const permissions = await getPermissionsForUserContext({
      userId,
      organizationId,
    });
    const resource = LEGACY_RESOURCE_FOR_KIND[kind];
    const actions = permissions[resource] ?? [];
    if (
      authorId !== userId &&
      !(kind === "remoteAgent"
        ? actions.includes("update")
        : await managesEveryObject({
            kind: kind as "plugin" | "project",
            userId,
            organizationId,
          }))
    )
      throw new ApiError(
        403,
        "Only the owner or a resource admin can transfer ownership",
      );
  }
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
  if (!scoped) {
    const resource = LEGACY_RESOURCE_FOR_KIND[kind];
    const recipientPermissions = await getPermissionsForUserContext({
      userId: ownerId,
      organizationId,
    });
    const recipient = recipientPermissions[resource] ?? [];
    if (
      !recipient.includes("read") ||
      !recipient.includes("update") ||
      (kind === "plugin" &&
        !(await managesEveryObject({
          kind,
          userId: ownerId,
          organizationId,
        })))
    )
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
  if (scoped) {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    await ResourcePermissions.transferOwnerGrant({
      organizationId,
      resource: scoped,
      scope: id,
      previousOwnerId: authorId,
      ownerId,
    });
    // SPDX-SnippetEnd
  }
}

/** Kinds still authorized by role permissions alone. */
const LEGACY_RESOURCE_FOR_KIND: Record<
  "skill" | "plugin" | "project" | "app" | "catalog" | "remoteAgent",
  Resource
> = {
  skill: "skill",
  app: "app",
  catalog: "mcpRegistry",
  plugin: "plugin",
  project: "project",
  remoteAgent: "agentSettings",
};

/**
 * Whether the user holds `update` on every object of this kind — the grant at
 * `*` that the retired `admin` role action became.
 */
async function managesEveryObject(params: {
  kind: "plugin" | "project";
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  return ResourcePermissions.allows({
    userId: params.userId,
    organizationId: params.organizationId,
    resource: params.kind,
    scope: "*",
    action: "update",
  });
  // SPDX-SnippetEnd
}

/** Kinds whose access is a grant policy; the rest still use role permissions. */
const SCOPED_RESOURCE_KINDS: Record<
  "skill" | "plugin" | "project" | "app" | "catalog" | "remoteAgent",
  ScopedResource | null
> = {
  skill: "skill",
  app: "app",
  catalog: "mcpRegistry",
  plugin: null,
  project: null,
  remoteAgent: null,
};

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
