import { asc, eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
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
   * Get or create a label key
   */
  static async getOrCreateKey(key: string): Promise<string> {
    // Try to find existing key
    const [existing] = await db
      .select()
      .from(schema.labelKeysTable)
      .where(eq(schema.labelKeysTable.key, key))
      .limit(1);

    if (existing) {
      return existing.id;
    }

    // Create new key
    const [created] = await db
      .insert(schema.labelKeysTable)
      .values({ key })
      .returning();

    return created.id;
  }

  /**
   * Get or create a label value
   */
  static async getOrCreateValue(value: string): Promise<string> {
    // Try to find existing value
    const [existing] = await db
      .select()
      .from(schema.labelValuesTable)
      .where(eq(schema.labelValuesTable.value, value))
      .limit(1);

    if (existing) {
      return existing.id;
    }

    // Create new value
    const [created] = await db
      .insert(schema.labelValuesTable)
      .values({ value })
      .returning();

    return created.id;
  }

  /**
   * Sync labels for an agent (replaces all existing labels)
   */
  static async syncAgentLabels(
    agentId: string,
    labels: AgentLabelWithDetails[],
  ): Promise<void> {
    // Process labels outside of transaction to avoid deadlocks
    const labelInserts: { agentId: string; keyId: string; valueId: string }[] =
      [];

    if (labels.length > 0) {
      // Process each label to get or create keys/values
      for (const label of labels) {
        const keyId = await AgentLabelModel.getOrCreateKey(label.key);
        const valueId = await AgentLabelModel.getOrCreateValue(label.value);
        labelInserts.push({ agentId, keyId, valueId });
      }
    }

    await db.transaction(async (tx) => {
      // Delete all existing labels for this agent
      await tx
        .delete(schema.agentLabelsTable)
        .where(eq(schema.agentLabelsTable.agentId, agentId));

      // Insert new labels (if any provided)
      if (labelInserts.length > 0) {
        await tx.insert(schema.agentLabelsTable).values(labelInserts);
      }
    });

    await AgentLabelModel.pruneKeysAndValues();
  }

  /**
   * Prune orphaned label keys and values that are no longer referenced
   * by any agent labels
   */
  static async pruneKeysAndValues(): Promise<{
    deletedKeys: number;
    deletedValues: number;
  }> {
    return await db.transaction(async (tx) => {
      // Find orphaned keys (not referenced in agent_labels)
      const orphanedKeys = await tx
        .select({ id: schema.labelKeysTable.id })
        .from(schema.labelKeysTable)
        .leftJoin(
          schema.agentLabelsTable,
          eq(schema.labelKeysTable.id, schema.agentLabelsTable.keyId),
        )
        .where(isNull(schema.agentLabelsTable.keyId));

      // Find orphaned values (not referenced in agent_labels)
      const orphanedValues = await tx
        .select({ id: schema.labelValuesTable.id })
        .from(schema.labelValuesTable)
        .leftJoin(
          schema.agentLabelsTable,
          eq(schema.labelValuesTable.id, schema.agentLabelsTable.valueId),
        )
        .where(isNull(schema.agentLabelsTable.valueId));

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
