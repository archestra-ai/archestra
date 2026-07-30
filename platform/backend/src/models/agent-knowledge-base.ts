import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { AgentKnowledgeBase } from "@/types";
import { ApiError } from "@/types";
import { agentKnowledgeSourcesCache } from "./agent-knowledge-sources-cache";
import AgentVersionModel from "./agent-version";

class AgentKnowledgeBaseModel {
  static async findByAgent(agentId: string): Promise<AgentKnowledgeBase[]> {
    // Join the KB parent so a soft-deleted KB stops surfacing to the agent
    // (list + retrieval resolution). Under hard delete the FK cascade dropped
    // the junction row; soft-delete leaves it, so filter here.
    return await db
      .select(getTableColumns(schema.agentKnowledgeBasesTable))
      .from(schema.agentKnowledgeBasesTable)
      .innerJoin(
        schema.knowledgeBasesTable,
        eq(
          schema.agentKnowledgeBasesTable.knowledgeBaseId,
          schema.knowledgeBasesTable.id,
        ),
      )
      .where(
        and(
          eq(schema.agentKnowledgeBasesTable.agentId, agentId),
          notDeleted(schema.knowledgeBasesTable),
        ),
      );
  }

  static async findByKnowledgeBase(
    knowledgeBaseId: string,
  ): Promise<AgentKnowledgeBase[]> {
    return await db
      .select(getTableColumns(schema.agentKnowledgeBasesTable))
      .from(schema.agentKnowledgeBasesTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentKnowledgeBasesTable.agentId, schema.agentsTable.id),
      )
      .where(
        and(
          eq(schema.agentKnowledgeBasesTable.knowledgeBaseId, knowledgeBaseId),
          notDeleted(schema.agentsTable),
        ),
      );
  }

  static async assign(agentId: string, knowledgeBaseId: string): Promise<void> {
    // Guard: never attach an agent to a soft-deleted KB. The row survives under
    // soft-delete, so without this the FK would accept a link to a gone KB.
    const [kb] = await db
      .select({ id: schema.knowledgeBasesTable.id })
      .from(schema.knowledgeBasesTable)
      .where(
        and(
          eq(schema.knowledgeBasesTable.id, knowledgeBaseId),
          notDeleted(schema.knowledgeBasesTable),
        ),
      );
    if (!kb) {
      throw new ApiError(404, "Knowledge base not found");
    }

    await db
      .insert(schema.agentKnowledgeBasesTable)
      .values({ agentId, knowledgeBaseId })
      .onConflictDoNothing();
    agentKnowledgeSourcesCache.invalidate(agentId);
    // Knowledge bases are part of the config snapshot — fork a version.
    // (AgentModel.update goes through syncForAgent, not here, so no double fork.)
    await AgentVersionModel.forkIfChangedBestEffort(agentId);
  }

  static async unassign(
    agentId: string,
    knowledgeBaseId: string,
  ): Promise<boolean> {
    const deleted = await db
      .delete(schema.agentKnowledgeBasesTable)
      .where(
        and(
          eq(schema.agentKnowledgeBasesTable.agentId, agentId),
          eq(schema.agentKnowledgeBasesTable.knowledgeBaseId, knowledgeBaseId),
        ),
      )
      .returning({ agentId: schema.agentKnowledgeBasesTable.agentId });

    agentKnowledgeSourcesCache.invalidate(agentId);
    if (deleted.length > 0) {
      await AgentVersionModel.forkIfChangedBestEffort(agentId);
    }
    return deleted.length > 0;
  }

  static async syncForAgent(
    agentId: string,
    knowledgeBaseIds: string[],
  ): Promise<void> {
    await db
      .delete(schema.agentKnowledgeBasesTable)
      .where(eq(schema.agentKnowledgeBasesTable.agentId, agentId));

    if (knowledgeBaseIds.length > 0) {
      await db
        .insert(schema.agentKnowledgeBasesTable)
        .values(
          knowledgeBaseIds.map((knowledgeBaseId) => ({
            agentId,
            knowledgeBaseId,
          })),
        )
        .onConflictDoNothing();
    }
    agentKnowledgeSourcesCache.invalidate(agentId);
  }

  static async getKnowledgeBaseIds(agentId: string): Promise<string[]> {
    // Join the KB parent so soft-deleted KBs drop out (agent resolution path).
    const results = await db
      .select({
        knowledgeBaseId: schema.agentKnowledgeBasesTable.knowledgeBaseId,
      })
      .from(schema.agentKnowledgeBasesTable)
      .innerJoin(
        schema.knowledgeBasesTable,
        eq(
          schema.agentKnowledgeBasesTable.knowledgeBaseId,
          schema.knowledgeBasesTable.id,
        ),
      )
      .where(
        and(
          eq(schema.agentKnowledgeBasesTable.agentId, agentId),
          notDeleted(schema.knowledgeBasesTable),
        ),
      );

    return results.map((r) => r.knowledgeBaseId);
  }

  /**
   * Batch fetch: for a list of agent IDs, return a map of agentId → knowledgeBaseId[].
   */
  static async getKnowledgeBaseIdsForAgents(
    agentIds: string[],
  ): Promise<Map<string, string[]>> {
    if (agentIds.length === 0) return new Map();

    // Join the KB parent so soft-deleted KBs drop out of agent list/detail
    // resolution (this is the batch resolver the agent endpoints use).
    const rows = await db
      .select({
        agentId: schema.agentKnowledgeBasesTable.agentId,
        knowledgeBaseId: schema.agentKnowledgeBasesTable.knowledgeBaseId,
      })
      .from(schema.agentKnowledgeBasesTable)
      .innerJoin(
        schema.knowledgeBasesTable,
        eq(
          schema.agentKnowledgeBasesTable.knowledgeBaseId,
          schema.knowledgeBasesTable.id,
        ),
      )
      .where(
        and(
          inArray(schema.agentKnowledgeBasesTable.agentId, agentIds),
          notDeleted(schema.knowledgeBasesTable),
        ),
      );

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.agentId) ?? [];
      list.push(row.knowledgeBaseId);
      map.set(row.agentId, list);
    }
    return map;
  }

  /**
   * Batch fetch: for a list of KB IDs, return a map of knowledgeBaseId → agentId[].
   */
  static async getAgentIdsForKnowledgeBases(
    knowledgeBaseIds: string[],
  ): Promise<Map<string, string[]>> {
    if (knowledgeBaseIds.length === 0) return new Map();

    const rows = await db
      .select()
      .from(schema.agentKnowledgeBasesTable)
      .where(
        inArray(
          schema.agentKnowledgeBasesTable.knowledgeBaseId,
          knowledgeBaseIds,
        ),
      );

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.knowledgeBaseId) ?? [];
      list.push(row.agentId);
      map.set(row.knowledgeBaseId, list);
    }
    return map;
  }
}

export default AgentKnowledgeBaseModel;
