import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { AgentKnowledgeBase } from "@/types";
import { agentKnowledgeSourcesCache } from "./agent-knowledge-sources-cache";
import AgentVersionModel from "./agent-version";

class AgentKnowledgeBaseModel {
  static async findByAgent(agentId: string): Promise<AgentKnowledgeBase[]> {
    return await db
      .select()
      .from(schema.agentKnowledgeBasesTable)
      .where(eq(schema.agentKnowledgeBasesTable.agentId, agentId));
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
    const results = await db
      .select({
        knowledgeBaseId: schema.agentKnowledgeBasesTable.knowledgeBaseId,
      })
      .from(schema.agentKnowledgeBasesTable)
      .where(eq(schema.agentKnowledgeBasesTable.agentId, agentId));

    return results.map((r) => r.knowledgeBaseId);
  }

  /**
   * Batch fetch: for a list of agent IDs, return a map of agentId → knowledgeBaseId[].
   */
  static async getKnowledgeBaseIdsForAgents(
    agentIds: string[],
  ): Promise<Map<string, string[]>> {
    if (agentIds.length === 0) return new Map();

    const rows = await db
      .select()
      .from(schema.agentKnowledgeBasesTable)
      .where(inArray(schema.agentKnowledgeBasesTable.agentId, agentIds));

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
