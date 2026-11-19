import { asc, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";

/**
 * Data access for per-agent delegation-target exclusions (Auto-subagent mode).
 * Pure CRUD — validation and orchestration live in
 * services/agent-subagent-exclusions.ts. The delegation analog of
 * {@link AgentExcludedToolModel}.
 */
class AgentExcludedSubagentModel {
  static async findTargetAgentIdsByAgent(
    agentId: string,
    tx?: Transaction,
  ): Promise<string[]> {
    const rows = await (tx ?? db)
      .select({
        targetAgentId: schema.agentExcludedSubagentsTable.targetAgentId,
      })
      .from(schema.agentExcludedSubagentsTable)
      .where(eq(schema.agentExcludedSubagentsTable.agentId, agentId))
      .orderBy(asc(schema.agentExcludedSubagentsTable.targetAgentId));

    return rows.map((row) => row.targetAgentId);
  }

  static async findTargetAgentIdsByAgents(
    agentIds: string[],
    tx?: Transaction,
  ): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    if (agentIds.length === 0) {
      return map;
    }

    const rows = await (tx ?? db)
      .select({
        agentId: schema.agentExcludedSubagentsTable.agentId,
        targetAgentId: schema.agentExcludedSubagentsTable.targetAgentId,
      })
      .from(schema.agentExcludedSubagentsTable)
      .where(inArray(schema.agentExcludedSubagentsTable.agentId, agentIds))
      .orderBy(
        asc(schema.agentExcludedSubagentsTable.agentId),
        asc(schema.agentExcludedSubagentsTable.targetAgentId),
      );

    for (const row of rows) {
      let targetSet = map.get(row.agentId);
      if (!targetSet) {
        targetSet = new Set();
        map.set(row.agentId, targetSet);
      }
      targetSet.add(row.targetAgentId);
    }

    return map;
  }

  /**
   * Full replace of the agent's excluded delegation-target set. Accepts an
   * optional transaction handle for atomic multi-step writes.
   */
  static async replaceForAgent(
    agentId: string,
    targetAgentIds: string[],
    tx?: Transaction,
  ): Promise<void> {
    const executor = tx ?? db;
    await executor
      .delete(schema.agentExcludedSubagentsTable)
      .where(eq(schema.agentExcludedSubagentsTable.agentId, agentId));

    if (targetAgentIds.length > 0) {
      await executor
        .insert(schema.agentExcludedSubagentsTable)
        .values(
          targetAgentIds.map((targetAgentId) => ({ agentId, targetAgentId })),
        )
        .onConflictDoNothing();
    }
  }
}

export default AgentExcludedSubagentModel;
