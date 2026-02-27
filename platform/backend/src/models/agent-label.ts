import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type { AgentLabelWithDetails } from "@/types";

class AgentLabelModel {
  /**
   * Get all labels for a specific agent with key and value details
   */
  static async getLabelsForAgent(
    agentId: string,
  ): Promise<AgentLabelWithDetails[]> {
    const rows = await db
      .select({
        keyId: schema.agentLabelsTable.keyId,
        valueId: schema.agentLabelsTable.valueId,
        key: schema.labelKeysTable.key,
        value: schema.labelValuesTable.value,
      })
      .from(schema.agentLabelsTable)
      .leftJoin(
        schema.labelKeysTable,
        eq(schema.agentLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .leftJoin(
        schema.labelValuesTable,
        eq(schema.agentLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(eq(schema.agentLabelsTable.agentId, agentId))
      .orderBy(asc(schema.labelKeysTable.key));

    return rows.map((row) => ({
      keyId: row.keyId,
      valueId: row.valueId,
      key: row.key || "",
      value: row.value || "",
    }));
  }

  /**
   * Get or create a label key. Uses INSERT ON CONFLICT DO NOTHING + SELECT
   * to handle concurrent inserts atomically.
   */
  static async getOrCreateKey(
    key: string,
    txOrDb: Transaction | typeof db = db,
  ): Promise<string> {
    await txOrDb
      .insert(schema.labelKeysTable)
      .values({ key })
      .onConflictDoNothing({ target: schema.labelKeysTable.key });

    const [result] = await txOrDb
      .select({ id: schema.labelKeysTable.id })
      .from(schema.labelKeysTable)
      .where(eq(schema.labelKeysTable.key, key))
      .limit(1);

    return result.id;
  }

  /**
   * Get or create a label value. Uses INSERT ON CONFLICT DO NOTHING + SELECT
   * to handle concurrent inserts atomically.
   */
  static async getOrCreateValue(
    value: string,
    txOrDb: Transaction | typeof db = db,
  ): Promise<string> {
    await txOrDb
      .insert(schema.labelValuesTable)
      .values({ value })
      .onConflictDoNothing({ target: schema.labelValuesTable.value });

    const [result] = await txOrDb
      .select({ id: schema.labelValuesTable.id })
      .from(schema.labelValuesTable)
      .where(eq(schema.labelValuesTable.value, value))
      .limit(1);

    return result.id;
  }

  /**
   * Sync labels for an agent (replaces all existing labels).
   * All operations run inside a single transaction to prevent race conditions
   * where concurrent pruning could delete keys/values between creation and use.
   */
  static async syncAgentLabels(
    agentId: string,
    labels: AgentLabelWithDetails[],
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // Delete all existing labels for this agent
      await tx
        .delete(schema.agentLabelsTable)
        .where(eq(schema.agentLabelsTable.agentId, agentId));

      // Get or create keys/values and insert new labels within the same transaction
      if (labels.length > 0) {
        const labelInserts: {
          agentId: string;
          keyId: string;
          valueId: string;
        }[] = [];

        for (const label of labels) {
          const keyId = await AgentLabelModel.getOrCreateKey(label.key, tx);
          const valueId = await AgentLabelModel.getOrCreateValue(
            label.value,
            tx,
          );
          labelInserts.push({ agentId, keyId, valueId });
        }

        await tx.insert(schema.agentLabelsTable).values(labelInserts);
      }
    });

    // Fire-and-forget pruning to avoid race conditions with concurrent operations
    AgentLabelModel.pruneKeysAndValues().catch(() => {});
  }

  /**
   * Prune orphaned label keys and values that are no longer referenced
   * by any label junction table (agent_labels or mcp_catalog_labels)
   */
  static async pruneKeysAndValues(): Promise<{
    deletedKeys: number;
    deletedValues: number;
  }> {
    return await db.transaction(async (tx) => {
      // Find orphaned keys (not referenced in agent_labels OR mcp_catalog_labels)
      const orphanedKeys = await tx
        .select({ id: schema.labelKeysTable.id })
        .from(schema.labelKeysTable)
        .leftJoin(
          schema.agentLabelsTable,
          eq(schema.labelKeysTable.id, schema.agentLabelsTable.keyId),
        )
        .leftJoin(
          schema.mcpCatalogLabelsTable,
          eq(schema.labelKeysTable.id, schema.mcpCatalogLabelsTable.keyId),
        )
        .where(
          and(
            isNull(schema.agentLabelsTable.keyId),
            isNull(schema.mcpCatalogLabelsTable.keyId),
          ),
        );

      // Find orphaned values (not referenced in agent_labels OR mcp_catalog_labels)
      const orphanedValues = await tx
        .select({ id: schema.labelValuesTable.id })
        .from(schema.labelValuesTable)
        .leftJoin(
          schema.agentLabelsTable,
          eq(schema.labelValuesTable.id, schema.agentLabelsTable.valueId),
        )
        .leftJoin(
          schema.mcpCatalogLabelsTable,
          eq(schema.labelValuesTable.id, schema.mcpCatalogLabelsTable.valueId),
        )
        .where(
          and(
            isNull(schema.agentLabelsTable.valueId),
            isNull(schema.mcpCatalogLabelsTable.valueId),
          ),
        );

      let deletedKeys = 0;
      let deletedValues = 0;

      // Delete orphaned keys
      if (orphanedKeys.length > 0) {
        const keyIds = orphanedKeys.map((k) => k.id);
        const result = await tx
          .delete(schema.labelKeysTable)
          .where(inArray(schema.labelKeysTable.id, keyIds));
        deletedKeys = result.rowCount || 0;
      }

      // Delete orphaned values
      if (orphanedValues.length > 0) {
        const valueIds = orphanedValues.map((v) => v.id);
        const result = await tx
          .delete(schema.labelValuesTable)
          .where(inArray(schema.labelValuesTable.id, valueIds));
        deletedValues = result.rowCount || 0;
      }

      return { deletedKeys, deletedValues };
    });
  }

  /**
   * Get all available label keys
   */
  static async getAllKeys(): Promise<string[]> {
    const keys = await db.select().from(schema.labelKeysTable);
    return keys.map((k) => k.key);
  }

  /**
   * Get all available label values
   */
  static async getAllValues(): Promise<string[]> {
    const values = await db.select().from(schema.labelValuesTable);
    return values.map((v) => v.value);
  }

  /**
   * Get labels for multiple agents in one query to avoid N+1
   */
  static async getLabelsForAgents(
    agentIds: string[],
  ): Promise<Map<string, AgentLabelWithDetails[]>> {
    if (agentIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({
        agentId: schema.agentLabelsTable.agentId,
        keyId: schema.agentLabelsTable.keyId,
        valueId: schema.agentLabelsTable.valueId,
        key: schema.labelKeysTable.key,
        value: schema.labelValuesTable.value,
      })
      .from(schema.agentLabelsTable)
      .leftJoin(
        schema.labelKeysTable,
        eq(schema.agentLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .leftJoin(
        schema.labelValuesTable,
        eq(schema.agentLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(inArray(schema.agentLabelsTable.agentId, agentIds))
      .orderBy(asc(schema.labelKeysTable.key));

    const labelsMap = new Map<string, AgentLabelWithDetails[]>();

    // Initialize all agent IDs with empty arrays
    for (const agentId of agentIds) {
      labelsMap.set(agentId, []);
    }

    // Populate the map with labels
    for (const row of rows) {
      const labels = labelsMap.get(row.agentId) || [];
      labels.push({
        keyId: row.keyId,
        valueId: row.valueId,
        key: row.key || "",
        value: row.value || "",
      });
      labelsMap.set(row.agentId, labels);
    }

    return labelsMap;
  }

  /**
   * Get all available label values for a specific key
   */
  static async getValuesByKey(key: string): Promise<string[]> {
    // Find the key ID
    const [keyRecord] = await db
      .select()
      .from(schema.labelKeysTable)
      .where(eq(schema.labelKeysTable.key, key))
      .limit(1);

    if (!keyRecord) {
      return [];
    }

    // Get all values associated with this key
    const values = await db
      .select({
        value: schema.labelValuesTable.value,
      })
      .from(schema.agentLabelsTable)
      .innerJoin(
        schema.labelValuesTable,
        eq(schema.agentLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(eq(schema.agentLabelsTable.keyId, keyRecord.id))
      .groupBy(schema.labelValuesTable.value)
      .orderBy(asc(schema.labelValuesTable.value));

    return values.map((v) => v.value);
  }
}

export default AgentLabelModel;
