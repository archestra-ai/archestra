// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  isBuiltInCatalogId,
  ORGANIZATION_WIDE_RESOURCES,
  type ResourcePermissionAction,
  type ScopedResource,
} from "@archestra/shared";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import CreatedByModel from "./created-by";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

export default class ResourcePermissionTargetModel {
  /** Discovery only. Execution must still check the specific target. */
  static async hasAnyCatalogGrant(params: {
    organizationId: string;
    userId: string;
    action: ResourcePermissionAction;
  }): Promise<boolean> {
    const table = schema.internalMcpCatalogTable;
    const [row] = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          or(
            eq(table.organizationId, params.organizationId),
            isNull(table.organizationId),
          ),
          isNull(table.deletedAt),
          isNull(table.parentCatalogItemId),
          ResourcePermissionPolicyModel.grantCondition({
            ...params,
            resource: "mcpRegistry",
            scopeColumn: table.id,
          }),
        ),
      )
      .limit(1);
    return !!row;
  }

  static async find(params: {
    organizationId: string;
    resource: ScopedResource;
    id: string;
  }): Promise<Target | null> {
    if (params.resource === "agent" || params.resource === "mcpGateway") {
      const table = schema.agentsTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.name,
          authorId: table.authorId,
          scope: table.scope,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
            isNull(table.deletedAt),
            inArray(
              table.agentType,
              params.resource === "agent"
                ? ["agent", "profile"]
                : ["mcp_gateway"],
            ),
          ),
        );
      if (!target) return null;
      const teams = await db
        .select({ id: schema.agentTeamsTable.teamId })
        .from(schema.agentTeamsTable)
        .where(eq(schema.agentTeamsTable.agentId, params.id));
      const users = await db
        .select({ id: schema.agentUsersTable.userId })
        .from(schema.agentUsersTable)
        .where(eq(schema.agentUsersTable.agentId, params.id));
      return { ...target, teams, users };
    }
    if (params.resource === "skill") {
      const table = schema.skillsTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.name,
          authorId: table.authorId,
          scope: table.scope,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
            isNull(table.deletedAt),
          ),
        );
      if (!target) return null;
      const teams = await db
        .select({ id: schema.skillTeamsTable.teamId })
        .from(schema.skillTeamsTable)
        .where(eq(schema.skillTeamsTable.skillId, params.id));
      const users = await db
        .select({ id: schema.skillUsersTable.userId })
        .from(schema.skillUsersTable)
        .where(eq(schema.skillUsersTable.skillId, params.id));
      return { ...target, teams, users };
    }
    if (params.resource === "llmModel") {
      const table = schema.modelsTable;
      const [target] = await db
        .select({ id: table.id, name: table.modelId })
        .from(table)
        .where(eq(table.id, params.id));
      if (!target) return null;
      const [teams, users] = await Promise.all([
        db
          .select({ id: schema.modelTeamsTable.teamId })
          .from(schema.modelTeamsTable)
          .where(eq(schema.modelTeamsTable.modelId, params.id)),
        db
          .select({ id: schema.modelUsersTable.userId })
          .from(schema.modelUsersTable)
          .where(eq(schema.modelUsersTable.modelId, params.id)),
      ]);
      return {
        ...target,
        authorId: null,
        scope: teams.length > 0 ? "team" : "org",
        teams,
        users,
      };
    }
    // Resources whose authority is organization-wide have no object to name,
    // so there is nothing to resolve. Their grants live at `*` alone.
    if (ORGANIZATION_WIDE_RESOURCES.has(params.resource)) return null;
    if (params.resource === "conversation" || params.resource === "agentRun") {
      const conversation = params.resource === "conversation";
      const table = conversation
        ? schema.conversationsTable
        : schema.agentRunsTable;
      const idColumn = conversation
        ? schema.conversationsTable.id
        : schema.agentRunsTable.taskId;
      const [target] = await db
        .select({
          id: idColumn,
          name: table.title,
          authorId: conversation
            ? schema.conversationsTable.userId
            : schema.agentRunsTable.actorUserId,
          enabled: conversation
            ? sql<boolean>`NOT ${schema.conversationsTable.lockedChat}`
            : sql<boolean>`true`,
        })
        .from(table)
        .where(
          and(
            eq(idColumn, params.id),
            eq(table.organizationId, params.organizationId),
            conversation
              ? isNull(schema.conversationsTable.deletedAt)
              : undefined,
          ),
        );
      if (!target) return null;
      const shares = conversation
        ? schema.conversationSharesTable
        : schema.agentRunSharesTable;
      const [share] = await db
        .select()
        .from(shares)
        .where(
          and(
            eq(
              conversation
                ? schema.conversationSharesTable.conversationId
                : schema.agentRunSharesTable.taskId,
              params.id,
            ),
            eq(shares.organizationId, params.organizationId),
          ),
        );
      const teamTable = conversation
        ? schema.conversationShareTeamsTable
        : schema.agentRunShareTeamsTable;
      const userTable = conversation
        ? schema.conversationShareUsersTable
        : schema.agentRunShareUsersTable;
      const [teams, users] = share
        ? await Promise.all([
            db
              .select({ id: teamTable.teamId })
              .from(teamTable)
              .where(eq(teamTable.shareId, share.id)),
            db
              .select({ id: userTable.userId })
              .from(userTable)
              .where(eq(userTable.shareId, share.id)),
          ])
        : [[], []];
      return {
        ...target,
        name: target.name ?? "Chat",
        scope:
          share?.visibility === "organization"
            ? "org"
            : share?.visibility === "team"
              ? "team"
              : "personal",
        teams: share?.visibility === "team" ? teams : [],
        users: share?.visibility === "user" ? users : [],
      };
    }
    if (params.resource === "project") {
      const table = schema.projectsTable;
      const [target] = await db
        .select({ id: table.id, name: table.name, authorId: table.userId })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
            isNull(table.deletedAt),
          ),
        );
      if (!target) return null;
      // A project's audience hangs off its share row, not the project.
      const [share] = await db
        .select({
          id: schema.projectSharesTable.id,
          visibility: schema.projectSharesTable.visibility,
        })
        .from(schema.projectSharesTable)
        .where(eq(schema.projectSharesTable.projectId, params.id));
      const [teams, users] = share
        ? await Promise.all([
            db
              .select({ id: schema.projectShareTeamsTable.teamId })
              .from(schema.projectShareTeamsTable)
              .where(eq(schema.projectShareTeamsTable.shareId, share.id)),
            db
              .select({ id: schema.projectShareUsersTable.userId })
              .from(schema.projectShareUsersTable)
              .where(eq(schema.projectShareUsersTable.shareId, share.id)),
          ])
        : [[], []];
      return {
        ...target,
        scope:
          share?.visibility === "organization"
            ? "org"
            : share?.visibility === "team"
              ? "team"
              : "personal",
        teams,
        users,
      };
    }
    if (params.resource === "plugin") {
      const table = schema.pluginsTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.displayName,
          authorId: table.authorId,
          scope: table.scope,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
            isNull(table.deletedAt),
          ),
        );
      if (!target) return null;
      const [teams, users] = await Promise.all([
        db
          .select({ id: schema.pluginTeamsTable.teamId })
          .from(schema.pluginTeamsTable)
          .where(eq(schema.pluginTeamsTable.pluginId, params.id)),
        db
          .select({ id: schema.pluginUsersTable.userId })
          .from(schema.pluginUsersTable)
          .where(eq(schema.pluginUsersTable.pluginId, params.id)),
      ]);
      return { ...target, teams, users };
    }
    if (params.resource === "serviceAccount") {
      const table = schema.serviceAccountsTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.name,
          createdBy: table.createdBy,
          createdByServiceAccountId: table.createdByServiceAccountId,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
          ),
        );
      if (!target) return null;
      // The organization owns a service account, not whoever happened to make
      // it: `created_by` is nullable by design and is set to null when that
      // person is deleted. So the scope is `org` and nobody is named on it —
      // the creator is reported only so the permissions editor can say who
      // made it, exactly as `CreatedByModel` does elsewhere.
      const { createdBy, createdByServiceAccountId, ...rest } = target;
      return {
        ...rest,
        authorId:
          CreatedByModel.id({ createdByServiceAccountId }, createdBy) ?? null,
        scope: "org",
        teams: [],
        users: [],
      };
    }
    if (params.resource === "llmVirtualKey") {
      const table = schema.virtualApiKeysTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.name,
          authorId: table.authorId,
          scope: table.scope,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
          ),
        );
      if (!target) return null;
      const teams = await db
        .select({ id: schema.virtualApiKeyTeamsTable.teamId })
        .from(schema.virtualApiKeyTeamsTable)
        .where(eq(schema.virtualApiKeyTeamsTable.virtualApiKeyId, params.id));
      return { ...target, teams, users: [] };
    }
    if (params.resource === "llmProviderApiKey") {
      const table = schema.llmProviderApiKeysTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.name,
          authorId: table.userId,
          scope: table.scope,
          teamId: table.teamId,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
          ),
        );
      if (!target) return null;
      // A provider key names its recipients in its own columns.
      const { teamId, ...rest } = target;
      return {
        ...rest,
        teams: teamId ? [{ id: teamId }] : [],
        users: [],
      };
    }
    if (
      params.resource === "knowledgeBase" ||
      params.resource === "knowledgeConnector"
    ) {
      const table =
        params.resource === "knowledgeBase"
          ? schema.knowledgeBasesTable
          : schema.knowledgeBaseConnectorsTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.name,
          visibility: table.visibility,
          teamIds: table.teamIds,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
            isNull(table.deletedAt),
          ),
        );
      if (!target) return null;
      // Knowledge keeps its teams as an array on the row, and carries no
      // author column at all, so a private object belongs to no one.
      return {
        id: target.id,
        name: target.name,
        authorId: null,
        scope: knowledgeScope(target.visibility),
        teams: (target.teamIds ?? []).map((id: string) => ({ id })),
        users: [],
      };
    }
    if (params.resource === "knowledgeFile") {
      const table = schema.kbFilesTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.filename,
          authorId: table.uploadedBy,
          visibility: table.visibility,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
          ),
        );
      if (!target) return null;
      const teams = await db
        .select({ id: schema.kbFileTeamsTable.teamId })
        .from(schema.kbFileTeamsTable)
        .where(eq(schema.kbFileTeamsTable.kbFileId, params.id));
      const { visibility, ...rest } = target;
      return { ...rest, scope: knowledgeScope(visibility), teams, users: [] };
    }
    if (params.resource === "environment") {
      const table = schema.environmentsTable;
      const [target] = await db
        .select({ id: table.id, name: table.name })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
          ),
        );
      if (!target) return null;
      // An environment is a place, not a possession: it has no author and no
      // audience of its own. Its whole access story is the grants below.
      return { ...target, authorId: null, scope: "org", teams: [], users: [] };
    }
    if (params.resource === "mcpRegistry" && isBuiltInCatalogId(params.id))
      return null;
    const catalog = schema.internalMcpCatalogTable;
    let catalogId = params.id;
    let app:
      | { id: string; name: string; authorId: string | null; enabled: boolean }
      | undefined;
    if (params.resource === "app") {
      const table = schema.appsTable;
      const [row] = await db
        .select({
          id: table.id,
          name: table.name,
          authorId: table.authorId,
          enabled: table.enabled,
          catalogId: schema.mcpServersTable.catalogId,
        })
        .from(table)
        .innerJoin(
          schema.mcpServersTable,
          eq(schema.mcpServersTable.id, table.mcpServerId),
        )
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
            isNull(table.deletedAt),
          ),
        );
      if (!row?.catalogId) return null;
      app = row;
      catalogId = row.catalogId;
    }
    const [target] = await db
      .select({
        id: catalog.id,
        name: catalog.name,
        authorId: catalog.authorId,
        scope: catalog.scope,
      })
      .from(catalog)
      .where(
        and(
          eq(catalog.id, catalogId),
          or(
            eq(catalog.organizationId, params.organizationId),
            isNull(catalog.organizationId),
          ),
          isNull(catalog.deletedAt),
        ),
      );
    if (!target) return null;
    const teams = await db
      .select({
        id: schema.mcpCatalogTeamsTable.teamId,
        level: schema.mcpCatalogTeamsTable.level,
      })
      .from(schema.mcpCatalogTeamsTable)
      .where(eq(schema.mcpCatalogTeamsTable.catalogId, catalogId));
    const users = await db
      .select({ id: schema.mcpCatalogUsersTable.userId })
      .from(schema.mcpCatalogUsersTable)
      .where(eq(schema.mcpCatalogUsersTable.catalogId, catalogId));
    return { ...target, ...app, teams, users };
  }
}

/**
 * The knowledge visibilities, in the vocabulary the grants use.
 *
 * Knowledge bases, connectors and files each spell their audience differently
 * (`private`, `org-wide`, `team-scoped`, `auto-sync-permissions`), and every
 * create path has to reach the same answer this resolver and the conversion
 * SQL reach, so the mapping lives here once.
 */
export function knowledgeScope(
  visibility: string | null,
): "personal" | "team" | "org" {
  if (visibility === "team-scoped") return "team";
  if (visibility === "private") return "personal";
  return "org";
}

type Target = {
  id: string;
  name: string;
  authorId: string | null;
  scope: "personal" | "team" | "org";
  teams: { id: string; level?: "use" | "write" }[];
  users: { id: string }[];
  enabled?: boolean;
};
