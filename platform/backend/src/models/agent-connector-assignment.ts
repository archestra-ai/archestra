import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { AgentConnectorAssignment } from "@/types";
import { ApiError } from "@/types";
import { agentKnowledgeSourcesCache } from "./agent-knowledge-sources-cache";
import AgentVersionModel from "./agent-version";

class AgentConnectorAssignmentModel {
  static async findByAgent(
    agentId: string,
  ): Promise<AgentConnectorAssignment[]> {
    // Join the connector parent so a soft-deleted connector stops surfacing to
    // the agent (list + retrieval resolution).
    return await db
      .select({
        agentId: schema.agentConnectorAssignmentsTable.agentId,
        connectorId: schema.agentConnectorAssignmentsTable.connectorId,
        createdAt: schema.agentConnectorAssignmentsTable.createdAt,
      })
      .from(schema.agentConnectorAssignmentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.agentConnectorAssignmentsTable.connectorId,
          schema.knowledgeBaseConnectorsTable.id,
        ),
      )
      .where(
        and(
          eq(schema.agentConnectorAssignmentsTable.agentId, agentId),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      );
  }

  /**
   * Deliberately NOT parent-filtered: this is the delete-path cache-invalidation
   * read, keyed on the connector being deleted. The knowledge-source-deletion
   * service captures the affected-agent set with it *before* stamping
   * `deleted_at`, so it must return rows regardless of the connector's state.
   */
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
    // Guard: never attach an agent to a soft-deleted connector (the row
    // survives soft-delete, so the FK alone won't stop it).
    const [connector] = await db
      .select({ id: schema.knowledgeBaseConnectorsTable.id })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          eq(schema.knowledgeBaseConnectorsTable.id, connectorId),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      );
    if (!connector) {
      throw new ApiError(404, "Connector not found");
    }

    await db
      .insert(schema.agentConnectorAssignmentsTable)
      .values({ agentId, connectorId })
      .onConflictDoNothing();
    agentKnowledgeSourcesCache.invalidate(agentId);
    // Connectors are part of the config snapshot — fork a version.
    // (AgentModel.update goes through syncForAgent, not here, so no double fork.)
    await AgentVersionModel.forkIfChangedBestEffort(agentId);
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

    agentKnowledgeSourcesCache.invalidate(agentId);
    if (rows.length > 0) {
      await AgentVersionModel.forkIfChangedBestEffort(agentId);
    }
    return rows.length > 0;
  }

  static async unassignAllFromAgent(agentId: string): Promise<number> {
    const rows = await db
      .delete(schema.agentConnectorAssignmentsTable)
      .where(eq(schema.agentConnectorAssignmentsTable.agentId, agentId))
      .returning({
        agentId: schema.agentConnectorAssignmentsTable.agentId,
      });

    agentKnowledgeSourcesCache.invalidate(agentId);
    return rows.length;
  }

  static async getConnectorIds(agentId: string): Promise<string[]> {
    // Join the connector parent so soft-deleted connectors drop out of agent
    // resolution (retrieval + the query_knowledge_sources hot path).
    const results = await db
      .select({
        connectorId: schema.agentConnectorAssignmentsTable.connectorId,
      })
      .from(schema.agentConnectorAssignmentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.agentConnectorAssignmentsTable.connectorId,
          schema.knowledgeBaseConnectorsTable.id,
        ),
      )
      .where(
        and(
          eq(schema.agentConnectorAssignmentsTable.agentId, agentId),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      );

    return results.map((r) => r.connectorId);
  }

  static async syncForAgent(
    agentId: string,
    connectorIds: string[],
  ): Promise<void> {
    await db
      .delete(schema.agentConnectorAssignmentsTable)
      .where(eq(schema.agentConnectorAssignmentsTable.agentId, agentId));

    if (connectorIds.length > 0) {
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
    agentKnowledgeSourcesCache.invalidate(agentId);
  }

  static async syncForAgentAssignments(params: {
    connectorId: string;
    agentIds: string[];
  }): Promise<void> {
    // Returning the previously-assigned agents so their cached
    // knowledge-source presence is invalidated along with the new set's.
    const removed = await db
      .delete(schema.agentConnectorAssignmentsTable)
      .where(
        eq(
          schema.agentConnectorAssignmentsTable.connectorId,
          params.connectorId,
        ),
      )
      .returning({
        agentId: schema.agentConnectorAssignmentsTable.agentId,
      });

    if (params.agentIds.length > 0) {
      await db
        .insert(schema.agentConnectorAssignmentsTable)
        .values(
          params.agentIds.map((agentId) => ({
            agentId,
            connectorId: params.connectorId,
          })),
        )
        .onConflictDoNothing();
    }

    const touched = new Set([
      ...removed.map((r) => r.agentId),
      ...params.agentIds,
    ]);
    for (const agentId of touched) {
      agentKnowledgeSourcesCache.invalidate(agentId);
    }
    // Connectors are part of the config snapshot, and this path writes the
    // junction directly rather than through AgentModel.update — fork every
    // agent that gained or lost the connector.
    await AgentVersionModel.forkAgentsBestEffort(touched);
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

    // Join the connector parent so soft-deleted connectors drop out of agent
    // list/detail resolution (the batch resolver the agent endpoints use).
    const rows = await db
      .select({
        agentId: schema.agentConnectorAssignmentsTable.agentId,
        connectorId: schema.agentConnectorAssignmentsTable.connectorId,
      })
      .from(schema.agentConnectorAssignmentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.agentConnectorAssignmentsTable.connectorId,
          schema.knowledgeBaseConnectorsTable.id,
        ),
      )
      .where(
        and(
          inArray(schema.agentConnectorAssignmentsTable.agentId, agentIds),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      );

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
