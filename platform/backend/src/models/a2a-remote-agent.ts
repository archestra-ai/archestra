import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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
    return {
      id: remoteAgent.id,
      organizationId: remoteAgent.organizationId,
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
      .where(eq(schema.a2aRemoteAgentsTable.organizationId, organizationId))
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
}

class A2aConnectionModel {
  static async findAssignedTargets(
    agentId: string,
    organizationId: string,
    includeDisabled = false,
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
        ),
      );
  }

  static async findAssignedTargetByToolName(params: {
    agentId: string;
    organizationId: string;
    toolName: string;
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
        ),
      );
  }
}

export { A2aConnectionModel };
export default A2aRemoteAgentModel;
