import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { LabelGetResponse, LabelWithDetails } from "@/types";

// =============================================================================
// Junction registry
// =============================================================================

/**
 * One entity's label junction table, reduced to the two columns pruning needs.
 */
interface LabelJunction {
  table: PgTable;
  keyId: AnyPgColumn;
  valueId: AnyPgColumn;
}

/**
 * EVERY label junction table in the schema.
 *
 * `pruneKeysAndValues` treats a key/value that no junction here references as
 * orphaned and deletes it, which cascades away any label rows still using it.
 * A junction missing from this list therefore loses its labels the next time
 * some other entity's labels are synced — so adding a labelled entity means
 * adding it here, and the registry test asserts this list covers every
 * `*_labels` table in the schema so the two cannot drift apart.
 *
 * @public — consumed by entity-label.test.ts's registry-drift invariant.
 */
export const LABEL_JUNCTIONS: LabelJunction[] = [
  {
    table: schema.agentLabelsTable,
    keyId: schema.agentLabelsTable.keyId,
    valueId: schema.agentLabelsTable.valueId,
  },
  {
    table: schema.appLabelsTable,
    keyId: schema.appLabelsTable.keyId,
    valueId: schema.appLabelsTable.valueId,
  },
  {
    table: schema.mcpCatalogLabelsTable,
    keyId: schema.mcpCatalogLabelsTable.keyId,
    valueId: schema.mcpCatalogLabelsTable.valueId,
  },
  {
    table: schema.teamLabelsTable,
    keyId: schema.teamLabelsTable.keyId,
    valueId: schema.teamLabelsTable.valueId,
  },
  {
    table: schema.environmentLabelsTable,
    keyId: schema.environmentLabelsTable.keyId,
    valueId: schema.environmentLabelsTable.valueId,
  },
  {
    table: schema.kbFileLabelsTable,
    keyId: schema.kbFileLabelsTable.keyId,
    valueId: schema.kbFileLabelsTable.valueId,
  },
  {
    table: schema.knowledgeBaseLabelsTable,
    keyId: schema.knowledgeBaseLabelsTable.keyId,
    valueId: schema.knowledgeBaseLabelsTable.valueId,
  },
  {
    table: schema.knowledgeBaseConnectorLabelsTable,
    keyId: schema.knowledgeBaseConnectorLabelsTable.keyId,
    valueId: schema.knowledgeBaseConnectorLabelsTable.valueId,
  },
  {
    table: schema.limitLabelsTable,
    keyId: schema.limitLabelsTable.keyId,
    valueId: schema.limitLabelsTable.valueId,
  },
  {
    table: schema.llmProviderApiKeyLabelsTable,
    keyId: schema.llmProviderApiKeyLabelsTable.keyId,
    valueId: schema.llmProviderApiKeyLabelsTable.valueId,
  },
  {
    table: schema.modelLabelsTable,
    keyId: schema.modelLabelsTable.keyId,
    valueId: schema.modelLabelsTable.valueId,
  },
  {
    table: schema.oauthClientLabelsTable,
    keyId: schema.oauthClientLabelsTable.keyId,
    valueId: schema.oauthClientLabelsTable.valueId,
  },
  {
    table: schema.pluginLabelsTable,
    keyId: schema.pluginLabelsTable.keyId,
    valueId: schema.pluginLabelsTable.valueId,
  },
  {
    table: schema.projectLabelsTable,
    keyId: schema.projectLabelsTable.keyId,
    valueId: schema.projectLabelsTable.valueId,
  },
  {
    table: schema.serviceAccountLabelsTable,
    keyId: schema.serviceAccountLabelsTable.keyId,
    valueId: schema.serviceAccountLabelsTable.valueId,
  },
  {
    table: schema.skillLabelsTable,
    keyId: schema.skillLabelsTable.keyId,
    valueId: schema.skillLabelsTable.valueId,
  },
  {
    table: schema.virtualApiKeyLabelsTable,
    keyId: schema.virtualApiKeyLabelsTable.keyId,
    valueId: schema.virtualApiKeyLabelsTable.valueId,
  },
];

// =============================================================================
// Shared key/value vocabulary
// =============================================================================

/**
 * Get or create a label key. `INSERT ... ON CONFLICT DO NOTHING` followed by a
 * SELECT so concurrent callers converge on the same row instead of failing.
 */
export async function getOrCreateLabelKey(
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
 * Get or create a label value. Same concurrency handling as
 * {@link getOrCreateLabelKey}.
 */
export async function getOrCreateLabelValue(
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
 * Delete label keys and values no junction in {@link LABEL_JUNCTIONS}
 * references any more.
 *
 * Deleting in one `DELETE ... WHERE NOT EXISTS` statement per table (rather
 * than SELECT-then-DELETE) keeps the emptiness check and the delete in the
 * same statement, so a row that gains a reference concurrently is not removed.
 */
export async function pruneLabelKeysAndValues(): Promise<{
  deletedKeys: number;
  deletedValues: number;
}> {
  return await withDbTransaction(async (tx) => {
    const deletedKeys = await tx
      .delete(schema.labelKeysTable)
      .where(
        and(
          ...LABEL_JUNCTIONS.map(
            (junction) =>
              sql`NOT EXISTS (SELECT 1 FROM ${junction.table} WHERE ${junction.keyId} = ${schema.labelKeysTable.id})`,
          ),
        ),
      )
      .returning({ id: schema.labelKeysTable.id });

    const deletedValues = await tx
      .delete(schema.labelValuesTable)
      .where(
        and(
          ...LABEL_JUNCTIONS.map(
            (junction) =>
              sql`NOT EXISTS (SELECT 1 FROM ${junction.table} WHERE ${junction.valueId} = ${schema.labelValuesTable.id})`,
          ),
        ),
      )
      .returning({ id: schema.labelValuesTable.id });

    return {
      deletedKeys: deletedKeys.length,
      deletedValues: deletedValues.length,
    };
  });
}

// =============================================================================
// Per-entity label model factory
// =============================================================================

interface EntityLabelModelConfig {
  junction: LabelJunction;
  /** The junction's FK back to the labelled row. */
  ownerIdColumn: AnyPgColumn;
  /**
   * The TypeScript property name of `ownerIdColumn` on the junction table
   * (`"skillId"`, not `"skill_id"`) — Drizzle's `.values()` keys by property
   * name, and the column object only carries the SQL name.
   */
  ownerIdKey: string;
  owner: {
    table: PgTable;
    idColumn: AnyPgColumn;
    /**
     * Restricts the key/value vocabulary listings to rows the organization can
     * see. Returns `undefined` for a globally shared catalog: the `models`
     * table has no organization column, so its rows — and therefore its labels
     * — are shared across the deployment, and scoping them is not possible.
     */
    organizationScope: (organizationId: string) => SQL | undefined;
  };
}

export interface EntityLabelModel {
  getLabelsFor(ownerId: string): Promise<LabelGetResponse[]>;
  getLabelsForMany(
    ownerIds: string[],
  ): Promise<Map<string, LabelWithDetails[]>>;
  getIdsMatchingLabels(labels: Record<string, string[]>): Promise<string[]>;
  syncLabels(
    ownerId: string,
    labels: LabelWithDetails[],
    tx?: Transaction,
  ): Promise<void>;
  getAllKeys(organizationId: string): Promise<string[]>;
  getValuesByKey(params: {
    organizationId: string;
    key: string;
  }): Promise<string[]>;
  getAllValues(organizationId: string): Promise<string[]>;
}

/**
 * Build the label model for one entity.
 *
 * Every labelled entity needs the same seven operations against a junction
 * table that differs only in its owner column, so they are generated from a
 * config rather than copied per entity.
 */
export function createEntityLabelModel(
  config: EntityLabelModelConfig,
): EntityLabelModel {
  const { junction, ownerIdColumn, ownerIdKey, owner } = config;

  /**
   * The junction joined to its keys, values and owner row.
   *
   * The owner join is what lets the organization scope filter the vocabulary,
   * so one organization is never offered another's label keys or values.
   * Distinct keys and distinct values need different projections (a grouped
   * query cannot select a column it does not group by), so there is one
   * builder per projection rather than one parameterised by it.
   */
  const distinctKeysQuery = () =>
    db
      .selectDistinct({ key: schema.labelKeysTable.key })
      .from(junction.table)
      .innerJoin(
        schema.labelKeysTable,
        eq(junction.keyId, schema.labelKeysTable.id),
      )
      .innerJoin(owner.table, eq(ownerIdColumn, owner.idColumn));

  const distinctValuesQuery = () =>
    db
      .selectDistinct({ value: schema.labelValuesTable.value })
      .from(junction.table)
      .innerJoin(
        schema.labelKeysTable,
        eq(junction.keyId, schema.labelKeysTable.id),
      )
      .innerJoin(
        schema.labelValuesTable,
        eq(junction.valueId, schema.labelValuesTable.id),
      )
      .innerJoin(owner.table, eq(ownerIdColumn, owner.idColumn));

  const replaceLabels = async (
    ownerId: string,
    labels: LabelWithDetails[],
    tx: Transaction,
  ): Promise<void> => {
    await tx.delete(junction.table).where(eq(ownerIdColumn, ownerId));

    if (labels.length === 0) {
      return;
    }

    // One value per key is a table invariant (the PK is (owner, key_id)), so a
    // repeated key collapses to its last value here rather than failing the
    // insert — callers reaching the model directly do not all pre-deduplicate.
    const byKey = new Map(labels.map((label) => [label.key, label]));

    const inserts: Record<string, string>[] = [];
    for (const label of byKey.values()) {
      inserts.push({
        [ownerIdKey]: ownerId,
        keyId: await getOrCreateLabelKey(label.key, tx),
        valueId: await getOrCreateLabelValue(label.value, tx),
      });
    }

    await tx.insert(junction.table).values(inserts);
  };

  return {
    async getLabelsFor(ownerId) {
      const rows = await db
        .select({
          keyId: junction.keyId,
          valueId: junction.valueId,
          key: schema.labelKeysTable.key,
          value: schema.labelValuesTable.value,
        })
        .from(junction.table)
        .leftJoin(
          schema.labelKeysTable,
          eq(junction.keyId, schema.labelKeysTable.id),
        )
        .leftJoin(
          schema.labelValuesTable,
          eq(junction.valueId, schema.labelValuesTable.id),
        )
        .where(eq(ownerIdColumn, ownerId))
        .orderBy(asc(schema.labelKeysTable.key));

      return rows.map((row) => ({
        keyId: row.keyId as string,
        valueId: row.valueId as string,
        key: row.key || "",
        value: row.value || "",
      }));
    },

    async getLabelsForMany(ownerIds) {
      const labelsMap = new Map<string, LabelWithDetails[]>();
      for (const ownerId of ownerIds) {
        labelsMap.set(ownerId, []);
      }

      if (ownerIds.length === 0) {
        return labelsMap;
      }

      const rows = await db
        .select({
          ownerId: ownerIdColumn,
          keyId: junction.keyId,
          valueId: junction.valueId,
          key: schema.labelKeysTable.key,
          value: schema.labelValuesTable.value,
        })
        .from(junction.table)
        .leftJoin(
          schema.labelKeysTable,
          eq(junction.keyId, schema.labelKeysTable.id),
        )
        .leftJoin(
          schema.labelValuesTable,
          eq(junction.valueId, schema.labelValuesTable.id),
        )
        .where(inArray(ownerIdColumn, ownerIds))
        .orderBy(asc(schema.labelKeysTable.key));

      for (const row of rows) {
        const ownerId = row.ownerId as string;
        const labels = labelsMap.get(ownerId) ?? [];
        labels.push({
          keyId: row.keyId as string,
          valueId: row.valueId as string,
          key: row.key || "",
          value: row.value || "",
        });
        labelsMap.set(ownerId, labels);
      }

      return labelsMap;
    },

    async getIdsMatchingLabels(labels) {
      const entries = Object.entries(labels).filter(
        ([, values]) => values.length > 0,
      );
      if (entries.length === 0) {
        return [];
      }

      // AND across keys, OR within a key's values: match any (key, value) pair
      // the filter allows, then keep only owners that matched every key. One
      // grouped query rather than one query per key.
      const rows = await db
        .select({ ownerId: ownerIdColumn })
        .from(junction.table)
        .innerJoin(
          schema.labelKeysTable,
          eq(junction.keyId, schema.labelKeysTable.id),
        )
        .innerJoin(
          schema.labelValuesTable,
          eq(junction.valueId, schema.labelValuesTable.id),
        )
        .where(
          or(
            ...entries.map(([key, values]) =>
              and(
                eq(schema.labelKeysTable.key, key),
                inArray(schema.labelValuesTable.value, values),
              ),
            ),
          ),
        )
        .groupBy(ownerIdColumn)
        .having(
          sql`count(distinct ${schema.labelKeysTable.key}) = ${entries.length}`,
        );

      return rows.map((row) => row.ownerId as string);
    },

    async syncLabels(ownerId, labels, tx) {
      if (tx) {
        await replaceLabels(ownerId, labels, tx);
        return;
      }

      await withDbTransaction((trx) => replaceLabels(ownerId, labels, trx));

      // Fire-and-forget: pruning is a cleanup, and failing it must not fail the
      // write the caller asked for.
      pruneLabelKeysAndValues().catch(() => {});
    },

    async getAllKeys(organizationId) {
      const rows = await distinctKeysQuery()
        .where(owner.organizationScope(organizationId))
        .orderBy(asc(schema.labelKeysTable.key));
      return rows.map((row) => row.key);
    },

    async getValuesByKey({ organizationId, key }) {
      const rows = await distinctValuesQuery()
        .where(
          and(
            owner.organizationScope(organizationId),
            eq(schema.labelKeysTable.key, key),
          ),
        )
        .orderBy(asc(schema.labelValuesTable.value));
      return rows.map((row) => row.value);
    },

    async getAllValues(organizationId) {
      const rows = await distinctValuesQuery()
        .where(owner.organizationScope(organizationId))
        .orderBy(asc(schema.labelValuesTable.value));
      return rows.map((row) => row.value);
    },
  };
}
