import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { AgentLabelGetResponse, AgentLabelWithDetails } from "@/types";
import AgentLabelModel from "./agent-label";

class RunnerLabelModel {
  /** Every label on one runner, ordered by key. */
  static async getLabelsForRunner(
    runnerId: string,
  ): Promise<AgentLabelGetResponse[]> {
    const rows = await db
      .select({
        keyId: schema.runnerLabelsTable.keyId,
        valueId: schema.runnerLabelsTable.valueId,
        key: schema.labelKeysTable.key,
        value: schema.labelValuesTable.value,
      })
      .from(schema.runnerLabelsTable)
      .leftJoin(
        schema.labelKeysTable,
        eq(schema.runnerLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .leftJoin(
        schema.labelValuesTable,
        eq(schema.runnerLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(eq(schema.runnerLabelsTable.runnerId, runnerId))
      .orderBy(asc(schema.labelKeysTable.key));

    return rows.map((row) => ({
      keyId: row.keyId,
      valueId: row.valueId,
      key: row.key || "",
      value: row.value || "",
    }));
  }

  /** Labels for many runners in one query, so a list page is not N+1. */
  static async getLabelsForRunners(
    runnerIds: string[],
  ): Promise<Map<string, AgentLabelWithDetails[]>> {
    const labelsMap = new Map<string, AgentLabelWithDetails[]>();
    for (const runnerId of runnerIds) {
      labelsMap.set(runnerId, []);
    }

    if (runnerIds.length === 0) {
      return labelsMap;
    }

    const rows = await db
      .select({
        runnerId: schema.runnerLabelsTable.runnerId,
        keyId: schema.runnerLabelsTable.keyId,
        valueId: schema.runnerLabelsTable.valueId,
        key: schema.labelKeysTable.key,
        value: schema.labelValuesTable.value,
      })
      .from(schema.runnerLabelsTable)
      .leftJoin(
        schema.labelKeysTable,
        eq(schema.runnerLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .leftJoin(
        schema.labelValuesTable,
        eq(schema.runnerLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(inArray(schema.runnerLabelsTable.runnerId, runnerIds))
      .orderBy(asc(schema.labelKeysTable.key));

    for (const row of rows) {
      const labels = labelsMap.get(row.runnerId) || [];
      labels.push({
        keyId: row.keyId,
        valueId: row.valueId,
        key: row.key || "",
        value: row.value || "",
      });
      labelsMap.set(row.runnerId, labels);
    }

    return labelsMap;
  }

  /**
   * Runner IDs matching a parsed labels filter: AND across keys, OR within one
   * key's values. An empty array means the filter matches nothing.
   */
  static async getRunnerIdsMatchingLabels(
    labels: Record<string, string[]>,
  ): Promise<string[]> {
    let matchingIds: string[] | null = null;

    for (const [key, values] of Object.entries(labels)) {
      const rows = await db
        .selectDistinct({ runnerId: schema.runnerLabelsTable.runnerId })
        .from(schema.runnerLabelsTable)
        .innerJoin(
          schema.labelKeysTable,
          eq(schema.runnerLabelsTable.keyId, schema.labelKeysTable.id),
        )
        .innerJoin(
          schema.labelValuesTable,
          eq(schema.runnerLabelsTable.valueId, schema.labelValuesTable.id),
        )
        .where(
          and(
            eq(schema.labelKeysTable.key, key),
            inArray(schema.labelValuesTable.value, values),
          ),
        );

      const ids = rows.map((r) => r.runnerId);
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
   * Replace a runner's labels. Joins an outer transaction when one is given so
   * a create/update stays atomic; otherwise opens its own and prunes the shared
   * vocabulary once that commits.
   */
  static async syncRunnerLabels(
    runnerId: string,
    labels: AgentLabelWithDetails[],
    tx?: Transaction,
  ): Promise<void> {
    if (tx) {
      await RunnerLabelModel.replaceLabels(runnerId, labels, tx);
      return;
    }

    await withDbTransaction((trx) =>
      RunnerLabelModel.replaceLabels(runnerId, labels, trx),
    );

    // Fire-and-forget: pruning races concurrent writers and is best-effort.
    AgentLabelModel.pruneKeysAndValues().catch(() => {});
  }

  /** Label keys in use by this organization's runners. */
  static async getAllKeys(organizationId: string): Promise<string[]> {
    const rows = await db
      .select({ key: schema.labelKeysTable.key })
      .from(schema.runnerLabelsTable)
      .innerJoin(
        schema.runnersTable,
        eq(schema.runnerLabelsTable.runnerId, schema.runnersTable.id),
      )
      .innerJoin(
        schema.labelKeysTable,
        eq(schema.runnerLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .where(eq(schema.runnersTable.organizationId, organizationId))
      .groupBy(schema.labelKeysTable.key)
      .orderBy(asc(schema.labelKeysTable.key));

    return rows.map((r) => r.key);
  }

  /** Label values in use by this organization's runners for one key. */
  static async getValuesByKey(params: {
    organizationId: string;
    key: string;
  }): Promise<string[]> {
    const { organizationId, key } = params;

    const rows = await db
      .select({ value: schema.labelValuesTable.value })
      .from(schema.runnerLabelsTable)
      .innerJoin(
        schema.runnersTable,
        eq(schema.runnerLabelsTable.runnerId, schema.runnersTable.id),
      )
      .innerJoin(
        schema.labelKeysTable,
        eq(schema.runnerLabelsTable.keyId, schema.labelKeysTable.id),
      )
      .innerJoin(
        schema.labelValuesTable,
        eq(schema.runnerLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(
        and(
          eq(schema.runnersTable.organizationId, organizationId),
          eq(schema.labelKeysTable.key, key),
        ),
      )
      .groupBy(schema.labelValuesTable.value)
      .orderBy(asc(schema.labelValuesTable.value));

    return rows.map((r) => r.value);
  }

  /** Every label value in use by this organization's runners. */
  static async getAllValues(organizationId: string): Promise<string[]> {
    const rows = await db
      .select({ value: schema.labelValuesTable.value })
      .from(schema.runnerLabelsTable)
      .innerJoin(
        schema.runnersTable,
        eq(schema.runnerLabelsTable.runnerId, schema.runnersTable.id),
      )
      .innerJoin(
        schema.labelValuesTable,
        eq(schema.runnerLabelsTable.valueId, schema.labelValuesTable.id),
      )
      .where(eq(schema.runnersTable.organizationId, organizationId))
      .groupBy(schema.labelValuesTable.value)
      .orderBy(asc(schema.labelValuesTable.value));

    return rows.map((r) => r.value);
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  private static async replaceLabels(
    runnerId: string,
    labels: AgentLabelWithDetails[],
    tx: Transaction,
  ): Promise<void> {
    await tx
      .delete(schema.runnerLabelsTable)
      .where(eq(schema.runnerLabelsTable.runnerId, runnerId));

    if (labels.length === 0) {
      return;
    }

    // One value per key is a table invariant (PK is (runner_id, key_id)), so a
    // repeated key collapses to its last value rather than failing the insert.
    const byKey = new Map(labels.map((label) => [label.key, label]));

    const inserts: { runnerId: string; keyId: string; valueId: string }[] = [];
    for (const label of byKey.values()) {
      const keyId = await AgentLabelModel.getOrCreateKey(label.key, tx);
      const valueId = await AgentLabelModel.getOrCreateValue(label.value, tx);
      inserts.push({ runnerId, keyId, valueId });
    }

    await tx.insert(schema.runnerLabelsTable).values(inserts);
  }
}

export default RunnerLabelModel;
