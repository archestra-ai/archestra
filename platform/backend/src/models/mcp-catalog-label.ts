import { and, asc, eq, inArray, or } from "drizzle-orm";
import { uniqBy } from "lodash-es";
import db, { schema } from "@/database";
import type { AgentLabelGetResponse, AgentLabelWithDetails } from "@/types";
import AgentLabelModel from "./agent-label";

class McpCatalogLabelModel {
  /**
   * Get all labels for a specific catalog item with key and value details
   */
  static async getLabelsForCatalogItem(
    catalogId: string,
  ): Promise<AgentLabelGetResponse[]> {
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

  static async getCatalogIdsByLabels(
    pairs: { keyId: string; valueId: string }[],
  ): Promise<string[]> {
    if (pairs.length === 0) {
      return [];
    }

    const rows = await db
      .selectDistinct({ catalogId: schema.mcpCatalogLabelsTable.catalogId })
      .from(schema.mcpCatalogLabelsTable)
      .where(
        or(
          ...pairs.map((pair) =>
            and(
              eq(schema.mcpCatalogLabelsTable.keyId, pair.keyId),
              eq(schema.mcpCatalogLabelsTable.valueId, pair.valueId),
            ),
          ),
        ),
      );

    return rows.map((r) => r.catalogId);
  }

  /**
   * Sync labels for a catalog item (replaces all existing labels).
   * Reuses AgentLabelModel.getOrCreateKey/Value for shared label_keys/label_values tables.
   * All operations run inside a single transaction to prevent race conditions
   * where concurrent pruning could delete keys/values between creation and use.
   */
  static async syncCatalogLabels(
    catalogId: string,
    labels: AgentLabelWithDetails[],
  ): Promise<void> {
    const affectedPairs = await db.transaction(async (tx) => {
      const previousLabels = await tx
        .select({
          keyId: schema.mcpCatalogLabelsTable.keyId,
          valueId: schema.mcpCatalogLabelsTable.valueId,
        })
        .from(schema.mcpCatalogLabelsTable)
        .where(eq(schema.mcpCatalogLabelsTable.catalogId, catalogId));

      const insertedLabels: {
        catalogId: string;
        keyId: string;
        valueId: string;
      }[] = [];

      // Delete all existing labels for this catalog item
      await tx
        .delete(schema.mcpCatalogLabelsTable)
        .where(eq(schema.mcpCatalogLabelsTable.catalogId, catalogId));

      // Upsert and assign new labels for this catalog item
      if (labels.length > 0) {
        for (const label of labels) {
          const { key, value } = label;
          const keyId = await AgentLabelModel.getOrCreateKey(key, tx);
          const valueId = await AgentLabelModel.getOrCreateValue(value, tx);
          insertedLabels.push({ catalogId, keyId, valueId });
        }

        await tx.insert(schema.mcpCatalogLabelsTable).values(insertedLabels);
      }

      // Return union of affected labels
      return uniqBy(
        [...previousLabels, ...insertedLabels],
        (l) => `${l.keyId}-${l.valueId}`,
      );
    });

    // Re-assign matched tools for agents and MCP gateways using automatic tool assignment.
    if (affectedPairs.length > 0) {
      const AgentModel = (await import("./agent")).default;
      const AgentToolModel = (await import("./agent-tool")).default;

      const matchedAgents = await AgentModel.findByLabels(affectedPairs);
      const affectedAgents = matchedAgents
        .filter((agent) => isAutomaticToolAssignmentSupported(agent.agentType))
        .filter((agent) => agent.toolAssignmentMode === "automatic");

      for (const agent of affectedAgents) {
        await AgentToolModel.syncAgentToolsFromLabels(agent.id);
      }
    }

    // Fire-and-forget pruning to avoid race conditions with concurrent operations
    AgentLabelModel.pruneKeysAndValues().catch(() => {});
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

function isAutomaticToolAssignmentSupported(agentType: string): boolean {
  return agentType === "agent" || agentType === "mcp_gateway";
}
