import { and, asc, eq } from "drizzle-orm";
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
  }

  /**
   * Add a single label to an agent
   */
  static async addLabelToAgent(
    agentId: string,
    key: string,
    value: string,
  ): Promise<void> {
    const keyId = await AgentLabelModel.getOrCreateKey(key);
    const valueId = await AgentLabelModel.getOrCreateValue(value);

    // Check if this key already exists for this agent
    const existing = await db
      .select()
      .from(schema.agentLabelTable)
      .where(
        and(
          eq(schema.agentLabelTable.agentId, agentId),
          eq(schema.agentLabelTable.keyId, keyId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // Update the value if key exists
      await db
        .update(schema.agentLabelTable)
        .set({ valueId })
        .where(
          and(
            eq(schema.agentLabelTable.agentId, agentId),
            eq(schema.agentLabelTable.keyId, keyId),
          ),
        );
    } else {
      // Insert new label
      await db
        .insert(schema.agentLabelTable)
        .values({ agentId, keyId, valueId });
    }
  }

  /**
   * Remove a label from an agent by key
   */
  static async removeLabelFromAgent(
    agentId: string,
    key: string,
  ): Promise<boolean> {
    // Find the key ID
    const [keyRecord] = await db
      .select()
      .from(schema.labelKeyTable)
      .where(eq(schema.labelKeyTable.key, key))
      .limit(1);

    if (!keyRecord) {
      return false;
    }

    const result = await db
      .delete(schema.agentLabelTable)
      .where(
        and(
          eq(schema.agentLabelTable.agentId, agentId),
          eq(schema.agentLabelTable.keyId, keyRecord.id),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
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
}

export default AgentLabelModel;
