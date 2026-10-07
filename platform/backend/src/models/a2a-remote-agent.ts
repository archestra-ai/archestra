import type {
  ResourcePermissionAction,
  ResourcePermissionGrant,
  ResourceVisibilityScope,
} from "@archestra/shared";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  max,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  A2aConnection,
  A2aRemoteAgent,
  InsertA2aConnection,
  InsertA2aRemoteAgent,
  Tool,
} from "@/types";
import CreatedByModel from "./created-by";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import ResourcePermissionSubjectModel from "./resource-permission-subject";

class A2aRemoteAgentModel {
  static async transferOwnership(params: {
    id: string;
    organizationId: string;
    previousOwnerId: string | null;
    updatedAt: Date;
    ownerId: string;
  }): Promise<boolean> {
    const rows = await db
      .update(schema.a2aRemoteAgentsTable)
      .set({
        authorId: params.ownerId,
        createdByServiceAccountId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.a2aRemoteAgentsTable.id, params.id),
          eq(schema.a2aRemoteAgentsTable.organizationId, params.organizationId),
          params.previousOwnerId === null
            ? isNull(schema.a2aRemoteAgentsTable.authorId)
            : eq(schema.a2aRemoteAgentsTable.authorId, params.previousOwnerId),
          sql`date_trunc('milliseconds', ${schema.a2aRemoteAgentsTable.updatedAt}) = ${params.updatedAt.toISOString()}::timestamp`,
        ),
      )
      .returning({ id: schema.a2aRemoteAgentsTable.id });
    return rows.length === 1;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await A2aRemoteAgentModel.findByIdForOrganization({
      id,
      organizationId,
    });
    if (!result) return null;

    const { remoteAgent, connection, toolId } = result;
    // Who can reach the agent lives in its permission policy, which audits
    // its own changes.
    return {
      id: remoteAgent.id,
      organizationId: remoteAgent.organizationId,
      authorId: remoteAgent.authorId,
      name: remoteAgent.name,
      description: remoteAgent.description,
      discoveryMode: remoteAgent.discoveryMode,
      discoveryUrl: remoteAgent.discoveryUrl,
      cardHash: remoteAgent.cardHash,
      connectionId: connection.id,
      selectedInterface: connection.selectedInterface,
      securityRequirement: connection.securityRequirement,
      authType: connection.authType,
      authConfig: connection.authConfig,
      hasCredential: connection.secretId !== null,
      enabled: connection.enabled,
      toolId,
      createdAt: remoteAgent.createdAt.toISOString(),
      updatedAt: remoteAgent.updatedAt.toISOString(),
    };
  }

  static async findAllForOrganization(organizationId: string): Promise<
    Array<{
      remoteAgent: A2aRemoteAgent;
      connection: A2aConnection;
      toolId: string;
    }>
  > {
    return A2aRemoteAgentModel.findAll({ organizationId });
  }

  static async findAllVisible(params: {
    organizationId: string;
    userId: string;
    scope?: ResourceVisibilityScope;
    teamId?: string;
    authorId?: string;
    ids?: string[];
  }): Promise<
    Array<{
      remoteAgent: A2aRemoteAgent;
      connection: A2aConnection;
      toolId: string;
    }>
  > {
    return A2aRemoteAgentModel.findAll(params);
  }

  static async findByIdVisible(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<{
    remoteAgent: A2aRemoteAgent;
    connection: A2aConnection;
    toolId: string;
  } | null> {
    const [result] = await A2aRemoteAgentModel.findAll(params, params.id);
    return result ?? null;
  }

  private static async findAll(
    params: {
      organizationId: string;
      userId?: string;
      scope?: ResourceVisibilityScope;
      teamId?: string;
      authorId?: string;
      ids?: string[];
    },
    id?: string,
  ): Promise<
    Array<{
      remoteAgent: A2aRemoteAgent;
      connection: A2aConnection;
      toolId: string;
    }>
  > {
    const conditions: Array<SQL | undefined> = [
      eq(schema.a2aRemoteAgentsTable.organizationId, params.organizationId),
      id ? eq(schema.a2aRemoteAgentsTable.id, id) : undefined,
      params.scope
        ? ResourcePermissionPolicyModel.audienceIs({
            organizationId: schema.a2aRemoteAgentsTable.organizationId,
            resource: "externalAgent",
            scopeColumn: schema.a2aRemoteAgentsTable.id,
            ownerColumn: schema.a2aRemoteAgentsTable.authorId,
            audience: params.scope,
          })
        : undefined,
      params.authorId
        ? eq(schema.a2aRemoteAgentsTable.authorId, params.authorId)
        : undefined,
      params.ids
        ? params.ids.length > 0
          ? inArray(schema.a2aRemoteAgentsTable.id, params.ids)
          : sql<boolean>`false`
        : undefined,
      params.teamId
        ? ResourcePermissionPolicyModel.grantsReadToAnyTeam({
            organizationId: schema.a2aRemoteAgentsTable.organizationId,
            resource: "externalAgent",
            scopeColumn: schema.a2aRemoteAgentsTable.id,
            teamIds: [params.teamId],
          })
        : undefined,
      params.userId
        ? await A2aRemoteAgentModel.accessCondition({
            organizationId: params.organizationId,
            userId: params.userId,
            action: "read",
          })
        : undefined,
    ];

    return db
      .select({
        remoteAgent: schema.a2aRemoteAgentsTable,
        connection: schema.a2aConnectionsTable,
        toolId: schema.toolsTable.id,
      })
      .from(schema.a2aRemoteAgentsTable)
      .innerJoin(
        schema.a2aConnectionsTable,
        eq(
          schema.a2aConnectionsTable.remoteAgentId,
          schema.a2aRemoteAgentsTable.id,
        ),
      )
      .innerJoin(
        schema.toolsTable,
        eq(
          schema.toolsTable.delegateToA2aConnectionId,
          schema.a2aConnectionsTable.id,
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(schema.a2aRemoteAgentsTable.updatedAt));
  }

  static async findByIdForOrganization(params: {
    id: string;
    organizationId: string;
  }): Promise<{
    remoteAgent: A2aRemoteAgent;
    connection: A2aConnection;
    toolId: string;
  } | null> {
    const [result] = await db
      .select({
        remoteAgent: schema.a2aRemoteAgentsTable,
        connection: schema.a2aConnectionsTable,
        toolId: schema.toolsTable.id,
      })
      .from(schema.a2aRemoteAgentsTable)
      .innerJoin(
        schema.a2aConnectionsTable,
        eq(
          schema.a2aConnectionsTable.remoteAgentId,
          schema.a2aRemoteAgentsTable.id,
        ),
      )
      .innerJoin(
        schema.toolsTable,
        eq(
          schema.toolsTable.delegateToA2aConnectionId,
          schema.a2aConnectionsTable.id,
        ),
      )
      .where(
        and(
          eq(schema.a2aRemoteAgentsTable.id, params.id),
          eq(schema.a2aRemoteAgentsTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);

    return result ?? null;
  }

  static async create(params: {
    data: InsertA2aRemoteAgent;
    /** The starting audience beyond the author; omitted means the author only. */
    initialPermissionGrants?: ResourcePermissionGrant[];
    /** Publish to the whole organization; for system callers only. */
    publishToOrganization?: boolean;
  }): Promise<A2aRemoteAgent> {
    return db.transaction(async (tx) => {
      const [remoteAgent] = await tx
        .insert(schema.a2aRemoteAgentsTable)
        .values(
          await CreatedByModel.forInsert({
            data: params.data,
            userIdField: "authorId",
            transaction: tx,
          }),
        )
        .returning();
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissionPolicyModel.createInitial({
        tx,
        organizationId: remoteAgent.organizationId,
        resource: "externalAgent",
        scope: remoteAgent.id,
        grants: params.initialPermissionGrants,
        authorId: remoteAgent.authorId,
        publishToOrganization: params.publishToOrganization,
      });
      // SPDX-SnippetEnd
      return remoteAgent;
    });
  }

  static async update(
    id: string,
    data: Partial<InsertA2aRemoteAgent>,
  ): Promise<A2aRemoteAgent | null> {
    const [remoteAgent] = await db
      .update(schema.a2aRemoteAgentsTable)
      .set(data)
      .where(eq(schema.a2aRemoteAgentsTable.id, id))
      .returning();
    return remoteAgent ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .delete(schema.a2aRemoteAgentsTable)
        .where(eq(schema.a2aRemoteAgentsTable.id, id))
        .returning({ id: schema.a2aRemoteAgentsTable.id });
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissionPolicyModel.deleteForTarget({
        tx,
        resources: ["externalAgent"],
        scope: id,
      });
      // SPDX-SnippetEnd
      return rows.length > 0;
    });
  }

  static async countAssignments(toolId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.agentToolsTable.id })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.toolId, toolId));
    return rows.length;
  }

  static async countAssignmentsByToolIds(
    toolIds: string[],
  ): Promise<Map<string, number>> {
    if (toolIds.length === 0) return new Map();
    const rows = await db
      .select({
        toolId: schema.agentToolsTable.toolId,
        assignmentCount: count(schema.agentToolsTable.id),
      })
      .from(schema.agentToolsTable)
      .where(inArray(schema.agentToolsTable.toolId, toolIds))
      .groupBy(schema.agentToolsTable.toolId);
    return new Map(
      rows.map((row) => [row.toolId, Number(row.assignmentCount)]),
    );
  }

  static async getLastUsedAtByRemoteAgentIds(
    remoteAgentIds: string[],
  ): Promise<Map<string, Date>> {
    if (remoteAgentIds.length === 0) return new Map();
    const rows = await db
      .select({
        remoteAgentId: schema.a2aOutboundRunsTable.remoteAgentId,
        lastUsedAt: max(schema.a2aOutboundRunsTable.startedAt),
      })
      .from(schema.a2aOutboundRunsTable)
      .where(inArray(schema.a2aOutboundRunsTable.remoteAgentId, remoteAgentIds))
      .groupBy(schema.a2aOutboundRunsTable.remoteAgentId);
    return new Map(
      rows.flatMap((row) =>
        row.remoteAgentId && row.lastUsedAt
          ? [[row.remoteAgentId, row.lastUsedAt] as const]
          : [],
      ),
    );
  }

  /**
   * External agents the user may reach with `action`, from each agent's own
   * permission policy and the organization-wide one.
   */
  static async accessCondition(params: {
    organizationId: string;
    userId: string;
    action: ResourcePermissionAction;
  }): Promise<SQL> {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const principal = await ResourcePermissionSubjectModel.resolvePrincipal({
      organizationId: params.organizationId,
      userId: params.userId,
    });
    return ResourcePermissionPolicyModel.grantCondition({
      ...principal,
      resource: "externalAgent",
      scopeColumn: schema.a2aRemoteAgentsTable.id,
      action: params.action,
    });
    // SPDX-SnippetEnd
  }
}

class A2aConnectionModel {
  static async findAssignedTargets(
    agentId: string,
    organizationId: string,
    includeDisabled = false,
    access?: { userId: string },
  ): Promise<
    Array<{
      remoteAgent: A2aRemoteAgent;
      connection: A2aConnection;
      tool: Tool;
    }>
  > {
    return db
      .select({
        remoteAgent: schema.a2aRemoteAgentsTable,
        connection: schema.a2aConnectionsTable,
        tool: schema.toolsTable,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .innerJoin(
        schema.a2aConnectionsTable,
        eq(
          schema.toolsTable.delegateToA2aConnectionId,
          schema.a2aConnectionsTable.id,
        ),
      )
      .innerJoin(
        schema.a2aRemoteAgentsTable,
        eq(
          schema.a2aConnectionsTable.remoteAgentId,
          schema.a2aRemoteAgentsTable.id,
        ),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.a2aRemoteAgentsTable.organizationId, organizationId),
          includeDisabled
            ? undefined
            : eq(schema.a2aConnectionsTable.enabled, true),
          isNull(schema.toolsTable.deletedAt),
          access
            ? await A2aRemoteAgentModel.accessCondition({
                organizationId,
                userId: access.userId,
                action: "use",
              })
            : undefined,
        ),
      );
  }

  static async findAssignedTargetByToolName(params: {
    agentId: string;
    organizationId: string;
    toolName: string;
    userId?: string;
  }): Promise<{
    remoteAgent: A2aRemoteAgent;
    connection: A2aConnection;
    tool: Tool;
  } | null> {
    const [target] = await db
      .select({
        remoteAgent: schema.a2aRemoteAgentsTable,
        connection: schema.a2aConnectionsTable,
        tool: schema.toolsTable,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .innerJoin(
        schema.a2aConnectionsTable,
        eq(
          schema.toolsTable.delegateToA2aConnectionId,
          schema.a2aConnectionsTable.id,
        ),
      )
      .innerJoin(
        schema.a2aRemoteAgentsTable,
        eq(
          schema.a2aConnectionsTable.remoteAgentId,
          schema.a2aRemoteAgentsTable.id,
        ),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, params.agentId),
          eq(schema.a2aRemoteAgentsTable.organizationId, params.organizationId),
          eq(schema.toolsTable.name, params.toolName),
          eq(schema.a2aConnectionsTable.enabled, true),
          isNull(schema.toolsTable.deletedAt),
          params.userId
            ? await A2aRemoteAgentModel.accessCondition({
                organizationId: params.organizationId,
                userId: params.userId,
                action: "use",
              })
            : undefined,
        ),
      )
      .limit(1);
    return target ?? null;
  }

  static async create(data: InsertA2aConnection): Promise<A2aConnection> {
    const [connection] = await db
      .insert(schema.a2aConnectionsTable)
      .values(data)
      .returning();
    return connection;
  }

  static async update(
    id: string,
    data: Partial<InsertA2aConnection>,
  ): Promise<A2aConnection | null> {
    const [connection] = await db
      .update(schema.a2aConnectionsTable)
      .set(data)
      .where(eq(schema.a2aConnectionsTable.id, id))
      .returning();
    return connection ?? null;
  }

  static async findByIds(ids: string[]): Promise<A2aConnection[]> {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(schema.a2aConnectionsTable)
      .where(inArray(schema.a2aConnectionsTable.id, ids));
  }

  static async findTargetsByIdsForOrganization(params: {
    ids: string[];
    organizationId: string;
    userId?: string;
  }): Promise<
    Array<{
      remoteAgent: A2aRemoteAgent;
      connection: A2aConnection;
      tool: Tool;
    }>
  > {
    if (params.ids.length === 0) return [];
    return db
      .select({
        remoteAgent: schema.a2aRemoteAgentsTable,
        connection: schema.a2aConnectionsTable,
        tool: schema.toolsTable,
      })
      .from(schema.a2aConnectionsTable)
      .innerJoin(
        schema.a2aRemoteAgentsTable,
        eq(
          schema.a2aConnectionsTable.remoteAgentId,
          schema.a2aRemoteAgentsTable.id,
        ),
      )
      .innerJoin(
        schema.toolsTable,
        eq(
          schema.toolsTable.delegateToA2aConnectionId,
          schema.a2aConnectionsTable.id,
        ),
      )
      .where(
        and(
          inArray(schema.a2aConnectionsTable.id, params.ids),
          eq(schema.a2aRemoteAgentsTable.organizationId, params.organizationId),
          eq(schema.a2aConnectionsTable.enabled, true),
          isNull(schema.toolsTable.deletedAt),
          params.userId
            ? await A2aRemoteAgentModel.accessCondition({
                organizationId: params.organizationId,
                userId: params.userId,
                action: "use",
              })
            : undefined,
        ),
      );
  }
}

export { A2aConnectionModel };
export default A2aRemoteAgentModel;
