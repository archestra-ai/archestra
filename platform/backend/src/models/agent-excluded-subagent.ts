import { asc, eq } from "drizzle-orm";
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
