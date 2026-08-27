import { asc, eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";

/**
 * Data access for per-agent knowledge-source (connector) exclusions in
 * Auto-tool mode. Pure CRUD — validation and orchestration live in
 * services/agent-knowledge-source-exclusions.ts. The knowledge analog of
 * {@link AgentExcludedToolModel}.
 */
class AgentExcludedConnectorModel {
  /**
   * Deliberately not joined to the connector parent: this is read on the
   * knowledge-query hot path to subtract ids from an already-visibility-
   * filtered set, and an id that no longer resolves subtracts nothing. Keeping
   * the row also preserves the operator's choice across a connector restore.
   */
  static async findConnectorIdsByAgent(
    agentId: string,
    tx?: Transaction,
  ): Promise<string[]> {
    const rows = await (tx ?? db)
      .select({ connectorId: schema.agentExcludedConnectorsTable.connectorId })
      .from(schema.agentExcludedConnectorsTable)
      .where(eq(schema.agentExcludedConnectorsTable.agentId, agentId))
      .orderBy(asc(schema.agentExcludedConnectorsTable.connectorId));

    return rows.map((row) => row.connectorId);
  }

  /**
   * Full replace of the agent's excluded knowledge-source set. Accepts an
   * optional transaction handle for atomic multi-step writes.
   */
  static async replaceForAgent(
    agentId: string,
    connectorIds: string[],
    tx?: Transaction,
  ): Promise<void> {
    const executor = tx ?? db;
    await executor
      .delete(schema.agentExcludedConnectorsTable)
      .where(eq(schema.agentExcludedConnectorsTable.agentId, agentId));

    if (connectorIds.length > 0) {
      await executor
        .insert(schema.agentExcludedConnectorsTable)
        .values(connectorIds.map((connectorId) => ({ agentId, connectorId })))
        .onConflictDoNothing();
    }
  }
}

export default AgentExcludedConnectorModel;
