import type { ResourceVisibilityScope } from "@archestra/shared";
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
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

class A2aRemoteAgentModel {
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
    const [teamRows, userRows] = await Promise.all([
      db
        .select({ id: schema.a2aRemoteAgentTeamsTable.teamId })
        .from(schema.a2aRemoteAgentTeamsTable)
        .where(
          eq(schema.a2aRemoteAgentTeamsTable.remoteAgentId, remoteAgent.id),
        ),
      db
        .select({ id: schema.a2aRemoteAgentUsersTable.userId })
        .from(schema.a2aRemoteAgentUsersTable)
        .where(
          eq(schema.a2aRemoteAgentUsersTable.remoteAgentId, remoteAgent.id),
        ),
    ]);
    return {
      id: remoteAgent.id,
      organizationId: remoteAgent.organizationId,
      authorId: remoteAgent.authorId,
      scope: remoteAgent.scope,
      teamIds: teamRows.map((row) => row.id).sort(),
      userIds: userRows.map((row) => row.id).sort(),
      name: remoteAgent.name,
      description: remoteAgent.description,
      discoveryMode: remoteAgent.discoveryMode,
      discoveryUrl: remoteAgent.discoveryUrl,
      cardHash: remoteAgent.cardHash,
      connectionId: connection.id,
      connectionName: connection.name,
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
    canManage: boolean;
    accessibleOnly?: boolean;
    scope?: ResourceVisibilityScope;
    teamId?: string;
    authorId?: string;
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
    canManage: boolean;
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
      canManage?: boolean;
      accessibleOnly?: boolean;
      scope?: ResourceVisibilityScope;
      teamId?: string;
      authorId?: string;
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
        ? eq(schema.a2aRemoteAgentsTable.scope, params.scope)
        : undefined,
      params.authorId
        ? eq(schema.a2aRemoteAgentsTable.authorId, params.authorId)
        : undefined,
      params.teamId
        ? exists(
            db
              .select({ value: sql`1` })
              .from(schema.a2aRemoteAgentTeamsTable)
              .where(
                and(
                  eq(
                    schema.a2aRemoteAgentTeamsTable.remoteAgentId,
                    schema.a2aRemoteAgentsTable.id,
                  ),
                  eq(schema.a2aRemoteAgentTeamsTable.teamId, params.teamId),
                ),
              ),
          )
        : undefined,
      params.userId && (params.accessibleOnly || !params.canManage)
        ? A2aRemoteAgentModel.visibilityCondition(params.userId)
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

  static async create(data: InsertA2aRemoteAgent): Promise<A2aRemoteAgent> {
    const [remoteAgent] = await db
      .insert(schema.a2aRemoteAgentsTable)
      .values(data)
      .returning();
    return remoteAgent;
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
    const rows = await db
      .delete(schema.a2aRemoteAgentsTable)
      .where(eq(schema.a2aRemoteAgentsTable.id, id))
      .returning({ id: schema.a2aRemoteAgentsTable.id });
    return rows.length > 0;
  }

  static async countAssignments(toolId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.agentToolsTable.id })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.toolId, toolId));
    return rows.length;
  }

  static visibilityCondition(userId: string): SQL {
    return sql<boolean>`(
      ${schema.a2aRemoteAgentsTable.scope} = 'org'
      OR (
        ${schema.a2aRemoteAgentsTable.scope} = 'personal'
        AND (
          ${schema.a2aRemoteAgentsTable.authorId} = ${userId}
          OR EXISTS (
            SELECT 1 FROM ${schema.a2aRemoteAgentUsersTable} grants
            WHERE grants.user_id = ${userId}
              AND grants.remote_agent_id = ${schema.a2aRemoteAgentsTable.id}
          )
        )
      )
      OR (
        ${schema.a2aRemoteAgentsTable.scope} = 'team'
        AND EXISTS (
          SELECT 1 FROM ${schema.a2aRemoteAgentTeamsTable} grants
          WHERE grants.remote_agent_id = ${schema.a2aRemoteAgentsTable.id}
            AND grants.team_id IN (
              WITH RECURSIVE effective_teams(team_id, organization_id) AS (
                SELECT tm.team_id, direct_team.organization_id
                FROM team_member tm
                INNER JOIN team direct_team ON direct_team.id = tm.team_id
                WHERE tm.user_id = ${userId}
                UNION
                SELECT parent_team.id, parent_team.organization_id
                FROM team child_team
                INNER JOIN effective_teams et ON child_team.id = et.team_id
                INNER JOIN team parent_team
                  ON parent_team.id = child_team.parent_team_id
                  AND parent_team.organization_id = et.organization_id
              )
              SELECT team_id FROM effective_teams
            )
        )
      )
    )`;
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
            ? A2aRemoteAgentModel.visibilityCondition(access.userId)
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
            ? A2aRemoteAgentModel.visibilityCondition(params.userId)
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
            ? A2aRemoteAgentModel.visibilityCondition(params.userId)
            : undefined,
        ),
      );
  }
}

export { A2aConnectionModel };
export default A2aRemoteAgentModel;
