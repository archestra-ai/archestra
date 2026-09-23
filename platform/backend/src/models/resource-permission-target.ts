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
      return target ?? null;
    }
    if (params.resource === "skill") {
      const table = schema.skillsTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.name,
          authorId: table.authorId,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
            isNull(table.deletedAt),
          ),
        );
      return target ?? null;
    }
    if (params.resource === "llmModel") {
      const table = schema.modelsTable;
      const [target] = await db
        .select({ id: table.id, name: table.modelId })
        .from(table)
        .where(eq(table.id, params.id));
      return target ? { ...target, authorId: null } : null;
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
      // Sharing lives on the session's permission policy alone. Without one,
      // the session is its author's.
      return { ...target, name: target.name ?? "Chat" };
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
      // Sharing lives on the project's permission policy alone. Without one,
      // the project is its owner's.
      return target;
    }
    if (params.resource === "plugin") {
      const table = schema.pluginsTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.displayName,
          authorId: table.authorId,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
            isNull(table.deletedAt),
          ),
        );
      return target ?? null;
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
      };
    }
    if (params.resource === "llmVirtualKey") {
      const table = schema.virtualApiKeysTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.name,
          authorId: table.authorId,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
          ),
        );
      return target ?? null;
    }
    if (params.resource === "llmProviderApiKey") {
      const table = schema.llmProviderApiKeysTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.name,
          authorId: table.userId,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
          ),
        );
      return target ?? null;
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
        .select({ id: table.id, name: table.name })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
            isNull(table.deletedAt),
          ),
        );
      // Knowledge carries no author column, so it names no author.
      return target ? { ...target, authorId: null } : null;
    }
    if (params.resource === "knowledgeFile") {
      const table = schema.kbFilesTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.filename,
          authorId: table.uploadedBy,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.organizationId, params.organizationId),
          ),
        );
      return target ?? null;
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
      return { ...target, authorId: null };
    }
    if (
      params.resource === "mcpOauthClient" ||
      params.resource === "llmOauthClient"
    ) {
      // Both kinds share the OAuth provider's table; the registration's
      // organization, kind and author live in its metadata.
      const table = schema.oauthClientsTable;
      const [target] = await db
        .select({
          id: table.id,
          name: table.name,
          clientId: table.clientId,
          authorId: sql<string | null>`${table.metadata}->>'authorId'`,
        })
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            sql`${table.metadata}->>'type' = ${
              params.resource === "mcpOauthClient"
                ? "mcp_oauth_client"
                : "llm_oauth_client"
            }`,
            sql`${table.metadata}->>'organizationId' = ${params.organizationId}`,
          ),
        );
      if (!target) return null;
      // Who can reach a registration is decided by its grants alone; the
      // retired `scope` in its metadata no longer means anything.
      return {
        id: target.id,
        name: target.name ?? target.clientId,
        authorId: target.authorId,
      };
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
    return { ...target, ...app };
  }
}

type Target = {
  id: string;
  name: string;
  authorId: string | null;
  enabled?: boolean;
};
