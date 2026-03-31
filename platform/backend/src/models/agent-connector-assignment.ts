import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentConnectorAssignment } from "@/types";

class AgentConnectorAssignmentModel {
  static async findByAgent(
    agentId: string,
  ): Promise<AgentConnectorAssignment[]> {
    return await db
      .select()
      .from(schema.agentConnectorAssignmentsTable)
      .where(eq(schema.agentConnectorAssignmentsTable.agentId, agentId));
  }

  static async findByConnector(
    connectorId: string,
  ): Promise<AgentConnectorAssignment[]> {
    return await db
      .select()
      .from(schema.agentConnectorAssignmentsTable)
      .where(
        eq(schema.agentConnectorAssignmentsTable.connectorId, connectorId),
      );
  }

  static async assign(agentId: string, connectorId: string): Promise<void> {
    await db
      .insert(schema.agentConnectorAssignmentsTable)
      .values({ agentId, connectorId })
      .onConflictDoNothing();
  }

  static async unassign(
    agentId: string,
    connectorId: string,
  ): Promise<boolean> {
    const rows = await db
      .delete(schema.agentConnectorAssignmentsTable)
      .where(
        and(
          eq(schema.agentConnectorAssignmentsTable.agentId, agentId),
          eq(schema.agentConnectorAssignmentsTable.connectorId, connectorId),
        ),
      )
      .returning({
        agentId: schema.agentConnectorAssignmentsTable.agentId,
      });

    return rows.length > 0;
  }

  static async unassignAllFromAgent(agentId: string): Promise<number> {
    const rows = await db
      .delete(schema.agentConnectorAssignmentsTable)
      .where(eq(schema.agentConnectorAssignmentsTable.agentId, agentId))
      .returning({
        agentId: schema.agentConnectorAssignmentsTable.agentId,
      });

    return rows.length;
  }

  static async getConnectorIds(agentId: string): Promise<string[]> {
    const results = await db
      .select({
        connectorId: schema.agentConnectorAssignmentsTable.connectorId,
      })
      .from(schema.agentConnectorAssignmentsTable)
      .where(eq(schema.agentConnectorAssignmentsTable.agentId, agentId));

    return results.map((r) => r.connectorId);
  }

  static async syncForAgent(
    agentId: string,
    connectorIds: string[],
  ): Promise<void> {
    await db
      .delete(schema.agentConnectorAssignmentsTable)
      .where(eq(schema.agentConnectorAssignmentsTable.agentId, agentId));

    if (connectorIds.length === 0) return;

    await db
      .insert(schema.agentConnectorAssignmentsTable)
      .values(
        connectorIds.map((connectorId) => ({
          agentId,
          connectorId,
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * Batch fetch: for a list of connector IDs, return a map of connectorId → agentId[].
   */
  static async getAgentIdsForConnectors(
    connectorIds: string[],
  ): Promise<Map<string, string[]>> {
    if (connectorIds.length === 0) return new Map();

    const rows = await db
      .select()
      .from(schema.agentConnectorAssignmentsTable)
      .where(
        inArray(
          schema.agentConnectorAssignmentsTable.connectorId,
          connectorIds,
        ),
      );

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.connectorId) ?? [];
      list.push(row.agentId);
      map.set(row.connectorId, list);
    }
    return map;
  }

  /**
   * Batch fetch: for a list of agent IDs, return a map of agentId → connectorId[].
   */
  static async getConnectorIdsForAgents(
    agentIds: string[],
  ): Promise<Map<string, string[]>> {
    if (agentIds.length === 0) return new Map();

    const rows = await db
      .select()
      .from(schema.agentConnectorAssignmentsTable)
      .where(inArray(schema.agentConnectorAssignmentsTable.agentId, agentIds));

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.agentId) ?? [];
      list.push(row.connectorId);
      map.set(row.agentId, list);
    }
    return map;
  }
}

export default AgentConnectorAssignmentModel;
