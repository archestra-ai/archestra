import { asc, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { LabelGetResponse, LabelWithDetails } from "@/types";
import {
  getOrCreateLabelKey,
  getOrCreateLabelValue,
  pruneLabelKeysAndValues,
} from "./entity-label";

class AgentLabelModel {
  /**
   * Get all labels for a specific agent with key and value details
   */
  static async getLabelsForAgent(agentId: string): Promise<LabelGetResponse[]> {
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
   * @see getOrCreateLabelKey — kept as a static so existing callers and tests
   * keep working now that the implementation is shared across every entity.
   */
  static async getOrCreateKey(
    key: string,
    txOrDb: Transaction | typeof db = db,
  ): Promise<string> {
    return getOrCreateLabelKey(key, txOrDb);
  }

  /** @see getOrCreateLabelValue */
  static async getOrCreateValue(
    value: string,
    txOrDb: Transaction | typeof db = db,
  ): Promise<string> {
    return getOrCreateLabelValue(value, txOrDb);
  }

  /**
   * Sync labels for an agent (replaces all existing labels).
   * All operations run inside a single transaction to prevent race conditions
   * where concurrent pruning could delete keys/values between creation and use.
   */
  static async syncAgentLabels(
    agentId: string,
    labels: LabelWithDetails[],
  ): Promise<void> {
    await withDbTransaction(async (tx) => {
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
   * Prune orphaned label keys and values.
   *
   * @see pruneLabelKeysAndValues — the junction tables it checks come from the
   * shared registry, so a newly labelled entity is covered automatically.
   */
  static async pruneKeysAndValues(): Promise<{
    deletedKeys: number;
    deletedValues: number;
  }> {
    return pruneLabelKeysAndValues();
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
  ): Promise<Map<string, LabelWithDetails[]>> {
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

    const labelsMap = new Map<string, LabelWithDetails[]>();

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
