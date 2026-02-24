import { asc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentLabelWithDetails } from "@/types";
import AgentLabelModel from "./agent-label";

class McpCatalogLabelModel {
  /**
   * Get all labels for a specific catalog item with key and value details
   */
  static async getLabelsForCatalogItem(
    catalogId: string,
  ): Promise<AgentLabelWithDetails[]> {
    const rows = await db
      .select({
        keyId: schema.mcpCatalogLabelsTable.keyId,
        valueId: schema.mcpCatalogLabelsTable.valueId,
        key: schema.labelKeysTable.key,
        value: schema.labelValuesTable.value,
      })
      .from(schema.mcpCatalogLabelsTable)
      .leftJoin(
        schema.labelKeysTable,
        eq(schema.mcpCatalogLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .leftJoin(
        schema.labelValuesTable,
        eq(schema.mcpCatalogLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(eq(schema.mcpCatalogLabelsTable.catalogId, catalogId))
      .orderBy(asc(schema.labelKeysTable.key));

    return rows.map((row) => ({
      keyId: row.keyId,
      valueId: row.valueId,
      key: row.key || "",
      value: row.value || "",
    }));
  }

  /**
   * Get labels for multiple catalog items in one query to avoid N+1
   */
  static async getLabelsForCatalogItems(
    catalogIds: string[],
  ): Promise<Map<string, AgentLabelWithDetails[]>> {
    if (catalogIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({
        catalogId: schema.mcpCatalogLabelsTable.catalogId,
        keyId: schema.mcpCatalogLabelsTable.keyId,
        valueId: schema.mcpCatalogLabelsTable.valueId,
        key: schema.labelKeysTable.key,
        value: schema.labelValuesTable.value,
      })
      .from(schema.mcpCatalogLabelsTable)
      .leftJoin(
        schema.labelKeysTable,
        eq(schema.mcpCatalogLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .leftJoin(
        schema.labelValuesTable,
        eq(schema.mcpCatalogLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(inArray(schema.mcpCatalogLabelsTable.catalogId, catalogIds))
      .orderBy(asc(schema.labelKeysTable.key));

    const labelsMap = new Map<string, AgentLabelWithDetails[]>();

    for (const catalogId of catalogIds) {
      labelsMap.set(catalogId, []);
    }

    for (const row of rows) {
      const labels = labelsMap.get(row.catalogId) || [];
      labels.push({
        keyId: row.keyId,
        valueId: row.valueId,
        key: row.key || "",
        value: row.value || "",
      });
      labelsMap.set(row.catalogId, labels);
    }

    return labelsMap;
  }

  /**
   * Sync labels for a catalog item (replaces all existing labels).
   * Reuses AgentLabelModel.getOrCreateKey/Value for shared label_keys/label_values tables.
   */
  static async syncCatalogLabels(
    catalogId: string,
    labels: AgentLabelWithDetails[],
  ): Promise<void> {
    const labelInserts: {
      catalogId: string;
      keyId: string;
      valueId: string;
    }[] = [];

    if (labels.length > 0) {
      for (const label of labels) {
        const keyId = await AgentLabelModel.getOrCreateKey(label.key);
        const valueId = await AgentLabelModel.getOrCreateValue(label.value);
        labelInserts.push({ catalogId, keyId, valueId });
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(schema.mcpCatalogLabelsTable)
        .where(eq(schema.mcpCatalogLabelsTable.catalogId, catalogId));

      if (labelInserts.length > 0) {
        await tx.insert(schema.mcpCatalogLabelsTable).values(labelInserts);
      }
    });

    await AgentLabelModel.pruneKeysAndValues();
  }

  /**
   * Get all label keys used by catalog items
   */
  static async getAllKeys(): Promise<string[]> {
    const rows = await db
      .select({ key: schema.labelKeysTable.key })
      .from(schema.mcpCatalogLabelsTable)
      .innerJoin(
        schema.labelKeysTable,
        eq(schema.mcpCatalogLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .groupBy(schema.labelKeysTable.key)
      .orderBy(asc(schema.labelKeysTable.key));

    return rows.map((r) => r.key);
  }

  /**
   * Get all label values for a specific key, scoped to catalog items
   */
  static async getValuesByKey(key: string): Promise<string[]> {
    const [keyRecord] = await db
      .select()
      .from(schema.labelKeysTable)
      .where(eq(schema.labelKeysTable.key, key))
      .limit(1);

    if (!keyRecord) {
      return [];
    }

    const values = await db
      .select({ value: schema.labelValuesTable.value })
      .from(schema.mcpCatalogLabelsTable)
      .innerJoin(
        schema.labelValuesTable,
        eq(schema.mcpCatalogLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(eq(schema.mcpCatalogLabelsTable.keyId, keyRecord.id))
      .groupBy(schema.labelValuesTable.value)
      .orderBy(asc(schema.labelValuesTable.value));

    return values.map((v) => v.value);
  }

  /**
   * Get all label values (unscoped), used by catalog items
   */
  static async getAllValues(): Promise<string[]> {
    const rows = await db
      .select({ value: schema.labelValuesTable.value })
      .from(schema.mcpCatalogLabelsTable)
      .innerJoin(
        schema.labelValuesTable,
        eq(schema.mcpCatalogLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .groupBy(schema.labelValuesTable.value)
      .orderBy(asc(schema.labelValuesTable.value));

    return rows.map((r) => r.value);
  }
}

export default McpCatalogLabelModel;
