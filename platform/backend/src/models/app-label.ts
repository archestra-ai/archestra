import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { AgentLabelGetResponse, AgentLabelWithDetails } from "@/types";
import AgentLabelModel from "./agent-label";

class AppLabelModel {
  /**
   * Get all labels for a specific app with key and value details
   */
  static async getLabelsForApp(
    appId: string,
  ): Promise<AgentLabelGetResponse[]> {
    const rows = await db
      .select({
        keyId: schema.appLabelsTable.keyId,
        valueId: schema.appLabelsTable.valueId,
        key: schema.labelKeysTable.key,
        value: schema.labelValuesTable.value,
      })
      .from(schema.appLabelsTable)
      .leftJoin(
        schema.labelKeysTable,
        eq(schema.appLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .leftJoin(
        schema.labelValuesTable,
        eq(schema.appLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(eq(schema.appLabelsTable.appId, appId))
      .orderBy(asc(schema.labelKeysTable.key));

    return rows.map((row) => ({
      keyId: row.keyId,
      valueId: row.valueId,
      key: row.key || "",
      value: row.value || "",
    }));
  }

  /**
   * Get labels for multiple apps in one query to avoid N+1
   */
  static async getLabelsForApps(
    appIds: string[],
  ): Promise<Map<string, AgentLabelWithDetails[]>> {
    const labelsMap = new Map<string, AgentLabelWithDetails[]>();
    for (const appId of appIds) {
      labelsMap.set(appId, []);
    }

    if (appIds.length === 0) {
      return labelsMap;
    }

    const rows = await db
      .select({
        appId: schema.appLabelsTable.appId,
        keyId: schema.appLabelsTable.keyId,
        valueId: schema.appLabelsTable.valueId,
        key: schema.labelKeysTable.key,
        value: schema.labelValuesTable.value,
      })
      .from(schema.appLabelsTable)
      .leftJoin(
        schema.labelKeysTable,
        eq(schema.appLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .leftJoin(
        schema.labelValuesTable,
        eq(schema.appLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(inArray(schema.appLabelsTable.appId, appIds))
      .orderBy(asc(schema.labelKeysTable.key));

    for (const row of rows) {
      const labels = labelsMap.get(row.appId) || [];
      labels.push({
        keyId: row.keyId,
        valueId: row.valueId,
        key: row.key || "",
        value: row.value || "",
      });
      labelsMap.set(row.appId, labels);
    }

    return labelsMap;
  }

  /**
   * Resolve the app IDs matching a parsed labels filter.
   * AND across keys (an app must match every key), OR within a key's values.
   * Returns an empty array when the filter matches no apps.
   */
  static async getAppIdsMatchingLabels(
    labels: Record<string, string[]>,
  ): Promise<string[]> {
    let matchingIds: string[] | null = null;

    for (const [key, values] of Object.entries(labels)) {
      const rows = await db
        .selectDistinct({ appId: schema.appLabelsTable.appId })
        .from(schema.appLabelsTable)
        .innerJoin(
          schema.labelKeysTable,
          eq(schema.appLabelsTable.keyId, schema.labelKeysTable.id),
        )
        .innerJoin(
          schema.labelValuesTable,
          eq(schema.appLabelsTable.valueId, schema.labelValuesTable.id),
        )
        .where(
          and(
            eq(schema.labelKeysTable.key, key),
            inArray(schema.labelValuesTable.value, values),
          ),
        );

      const ids = rows.map((r) => r.appId);
      matchingIds =
        matchingIds === null
          ? ids
          : matchingIds.filter((id) => ids.includes(id));

      if (matchingIds.length === 0) {
        return [];
      }
    }

    return matchingIds ?? [];
  }

  /**
   * Sync labels for an app (replaces all existing labels).
   * Reuses AgentLabelModel.getOrCreateKey/Value for the shared
   * label_keys/label_values tables. When an outer transaction is provided
   * (e.g. atomic app create/update), the writes join that transaction;
   * otherwise a dedicated transaction is opened. Pruning is fired only after
   * a self-managed transaction commits.
   */
  static async syncAppLabels(
    appId: string,
    labels: AgentLabelWithDetails[],
    tx?: Transaction,
  ): Promise<void> {
    if (tx) {
      await AppLabelModel.replaceLabels(appId, labels, tx);
      return;
    }

    await withDbTransaction((trx) =>
      AppLabelModel.replaceLabels(appId, labels, trx),
    );

    // Fire-and-forget pruning to avoid race conditions with concurrent operations
    AgentLabelModel.pruneKeysAndValues().catch(() => {});
  }

  /**
   * Get all label keys used by apps within an organization
   */
  static async getAllKeys(organizationId: string): Promise<string[]> {
    const rows = await db
      .select({ key: schema.labelKeysTable.key })
      .from(schema.appLabelsTable)
      .innerJoin(
        schema.appsTable,
        eq(schema.appLabelsTable.appId, schema.appsTable.id),
      )
      .innerJoin(
        schema.labelKeysTable,
        eq(schema.appLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          isNull(schema.appsTable.deletedAt),
        ),
      )
      .groupBy(schema.labelKeysTable.key)
      .orderBy(asc(schema.labelKeysTable.key));

    return rows.map((r) => r.key);
  }

  /**
   * Get all label values for a specific key, scoped to an organization's apps
   */
  static async getValuesByKey(params: {
    organizationId: string;
    key: string;
  }): Promise<string[]> {
    const { organizationId, key } = params;

    const values = await db
      .select({ value: schema.labelValuesTable.value })
      .from(schema.appLabelsTable)
      .innerJoin(
        schema.appsTable,
        eq(schema.appLabelsTable.appId, schema.appsTable.id),
      )
      .innerJoin(
        schema.labelKeysTable,
        eq(schema.appLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .innerJoin(
        schema.labelValuesTable,
        eq(schema.appLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          isNull(schema.appsTable.deletedAt),
          eq(schema.labelKeysTable.key, key),
        ),
      )
      .groupBy(schema.labelValuesTable.value)
      .orderBy(asc(schema.labelValuesTable.value));

    return values.map((v) => v.value);
  }

  /**
   * Get all label values (unscoped to key), used by an organization's apps
   */
  static async getAllValues(organizationId: string): Promise<string[]> {
    const rows = await db
      .select({ value: schema.labelValuesTable.value })
      .from(schema.appLabelsTable)
      .innerJoin(
        schema.appsTable,
        eq(schema.appLabelsTable.appId, schema.appsTable.id),
      )
      .innerJoin(
        schema.labelValuesTable,
        eq(schema.appLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          isNull(schema.appsTable.deletedAt),
        ),
      )
      .groupBy(schema.labelValuesTable.value)
      .orderBy(asc(schema.labelValuesTable.value));

    return rows.map((r) => r.value);
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  private static async replaceLabels(
    appId: string,
    labels: AgentLabelWithDetails[],
    tx: Transaction,
  ): Promise<void> {
    // Delete all existing labels for this app
    await tx
      .delete(schema.appLabelsTable)
      .where(eq(schema.appLabelsTable.appId, appId));

    if (labels.length === 0) {
      return;
    }

    // One value per key is a table invariant (PK is (app_id, key_id)), so a
    // repeated key collapses to its last value here rather than failing the
    // insert — callers reaching the model directly (e.g. the REST body) do not
    // all pre-deduplicate.
    const byKey = new Map(labels.map((label) => [label.key, label]));

    const inserts: { appId: string; keyId: string; valueId: string }[] = [];
    for (const label of byKey.values()) {
      const keyId = await AgentLabelModel.getOrCreateKey(label.key, tx);
      const valueId = await AgentLabelModel.getOrCreateValue(label.value, tx);
      inserts.push({ appId, keyId, valueId });
    }

    await tx.insert(schema.appLabelsTable).values(inserts);
  }
}

export default AppLabelModel;
