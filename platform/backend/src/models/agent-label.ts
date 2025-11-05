import { asc, eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentLabelWithDetails } from "@/types/label";

class AgentLabelModel {
  /**
   * Get all labels for a specific agent with key and value details
   */
  static async getLabelsForAgent(
    agentId: string,
  ): Promise<AgentLabelWithDetails[]> {
    const rows = await db
      .select({
        keyId: schema.agentLabelTable.keyId,
        valueId: schema.agentLabelTable.valueId,
        key: schema.labelKeyTable.key,
        value: schema.labelValueTable.value,
      })
      .from(schema.agentLabelTable)
      .leftJoin(
        schema.labelKeyTable,
        eq(schema.agentLabelTable.keyId, schema.labelKeyTable.id),
      )
      .leftJoin(
        schema.labelValueTable,
        eq(schema.agentLabelTable.valueId, schema.labelValueTable.id),
      )
      .where(eq(schema.agentLabelTable.agentId, agentId))
      .orderBy(asc(schema.labelKeyTable.key));

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
      .from(schema.labelKeyTable)
      .where(eq(schema.labelKeyTable.key, key))
      .limit(1);

    if (existing) {
      return existing.id;
    }

    // Create new key
    const [created] = await db
      .insert(schema.labelKeyTable)
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
      .from(schema.labelValueTable)
      .where(eq(schema.labelValueTable.value, value))
      .limit(1);

    if (existing) {
      return existing.id;
    }

    // Create new value
    const [created] = await db
      .insert(schema.labelValueTable)
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
        .delete(schema.agentLabelTable)
        .where(eq(schema.agentLabelTable.agentId, agentId));

      // Insert new labels (if any provided)
      if (labelInserts.length > 0) {
        await tx.insert(schema.agentLabelTable).values(labelInserts);
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
        .select({ id: schema.labelKeyTable.id })
        .from(schema.labelKeyTable)
        .leftJoin(
          schema.agentLabelTable,
          eq(schema.labelKeyTable.id, schema.agentLabelTable.keyId),
        )
        .where(isNull(schema.agentLabelTable.keyId));

      // Find orphaned values (not referenced in agent_labels)
      const orphanedValues = await tx
        .select({ id: schema.labelValueTable.id })
        .from(schema.labelValueTable)
        .leftJoin(
          schema.agentLabelTable,
          eq(schema.labelValueTable.id, schema.agentLabelTable.valueId),
        )
        .where(isNull(schema.agentLabelTable.valueId));

      let deletedKeys = 0;
      let deletedValues = 0;

      // Delete orphaned keys
      if (orphanedKeys.length > 0) {
        const keyIds = orphanedKeys.map((k) => k.id);
        const result = await tx
          .delete(schema.labelKeyTable)
          .where(inArray(schema.labelKeyTable.id, keyIds));
        deletedKeys = result.rowCount || 0;
      }

      // Delete orphaned values
      if (orphanedValues.length > 0) {
        const valueIds = orphanedValues.map((v) => v.id);
        const result = await tx
          .delete(schema.labelValueTable)
          .where(inArray(schema.labelValueTable.id, valueIds));
        deletedValues = result.rowCount || 0;
      }

      return { deletedKeys, deletedValues };
    });
  }

  /**
   * Get all available label keys
   */
  static async getAllKeys(): Promise<string[]> {
    const keys = await db.select().from(schema.labelKeyTable);
    return keys.map((k) => k.key);
  }

  /**
   * Get all available label values
   */
  static async getAllValues(): Promise<string[]> {
    const values = await db.select().from(schema.labelValueTable);
    return values.map((v) => v.value);
  }

  /**
   * Get all available label values for a specific key
   */
  static async getValuesByKey(key: string): Promise<string[]> {
    // Find the key ID
    const [keyRecord] = await db
      .select()
      .from(schema.labelKeyTable)
      .where(eq(schema.labelKeyTable.key, key))
      .limit(1);

    if (!keyRecord) {
      return [];
    }

    // Get all values associated with this key
    const values = await db
      .select({
        value: schema.labelValueTable.value,
      })
      .from(schema.agentLabelTable)
      .innerJoin(
        schema.labelValueTable,
        eq(schema.agentLabelTable.valueId, schema.labelValueTable.id),
      )
      .where(eq(schema.agentLabelTable.keyId, keyRecord.id))
      .groupBy(schema.labelValueTable.value)
      .orderBy(asc(schema.labelValueTable.value));

    return values.map((v) => v.value);
  }
}

export default AgentLabelModel;
