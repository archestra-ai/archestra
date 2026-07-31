import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  lt,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import db, { schema, type Transaction } from "@/database";
import type { SoftDeletableTable } from "@/database/schemas/soft-deletable-table";
import { hardDelete } from "@/database/soft-delete";
import type { DeletedItem, DeletedItemEntityType } from "@/types";

/**
 * The five soft-deletable entities, keyed by the `entityType` the Deleted Items
 * API speaks. Every one of them carries the same four columns this model reads
 * — id, organization, a display name, and `deleted_at` — so the trash listing,
 * the retention sweep, and permanent delete are one implementation over a
 * registry rather than five near-identical copies per model.
 *
 * `restorable: false` marks an entity that can be listed and purged but never
 * brought back. Apps are the only one: deleting an app hard-deletes its backing
 * MCP server and catalog entry (see `services/apps/app-mcp-backing.ts`), so
 * clearing `deleted_at` would resurrect a row whose launch tool no longer
 * exists. Restoring an app needs the backing recreated first, which is its own
 * change.
 */
const ENTITY_REGISTRY = {
  agent: {
    table: schema.agentsTable,
    nameColumn: schema.agentsTable.name,
    restorable: true,
  },
  app: {
    table: schema.appsTable,
    nameColumn: schema.appsTable.name,
    restorable: false,
  },
  conversation: {
    table: schema.conversationsTable,
    // Conversations title themselves lazily, so an untitled chat has NULL here;
    // the API layer supplies the fallback label rather than storing one.
    nameColumn: schema.conversationsTable.title,
    restorable: true,
  },
  project: {
    table: schema.projectsTable,
    nameColumn: schema.projectsTable.name,
    restorable: true,
  },
  skill: {
    table: schema.skillsTable,
    nameColumn: schema.skillsTable.name,
    restorable: true,
  },
} as const satisfies Record<
  DeletedItemEntityType,
  {
    table: PgTable & SoftDeletableTable;
    nameColumn: unknown;
    restorable: boolean;
  }
>;

export const DELETED_ITEM_ENTITY_TYPES = Object.keys(
  ENTITY_REGISTRY,
) as DeletedItemEntityType[];

class DeletedItemModel {
  /**
   * Every soft-deleted row in an organization, newest deletion first.
   *
   * Reads each entity's table separately and merges in memory rather than
   * issuing a five-way SQL UNION: the result set is bounded by the retention
   * window, each read is served by that table's partial `deleted_at` index, and
   * the merge keeps the query readable. `offset + limit` rows are taken from
   * every table so the merged page is correct at any offset.
   */
  static async listForOrganization(params: {
    organizationId: string;
    entityTypes?: DeletedItemEntityType[];
    limit: number;
    offset: number;
  }): Promise<DeletedItem[]> {
    const { organizationId, limit, offset } = params;
    const types = params.entityTypes?.length
      ? params.entityTypes
      : DELETED_ITEM_ENTITY_TYPES;

    const perTable = await Promise.all(
      types.map(async (entityType) => {
        const { table, nameColumn } = ENTITY_REGISTRY[entityType];
        const rows = await db
          .select({
            id: table.id,
            name: nameColumn as never,
            deletedAt: table.deletedAt,
          })
          .from(table)
          .where(deletedInOrg(table, organizationId))
          .orderBy(desc(table.deletedAt))
          .limit(offset + limit);

        return rows.map((row) => ({
          entityType,
          id: String(row.id),
          name: (row.name as string | null) ?? null,
          deletedAt: row.deletedAt as Date,
          restorable: ENTITY_REGISTRY[entityType].restorable,
        }));
      }),
    );

    return perTable
      .flat()
      .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime())
      .slice(offset, offset + limit);
  }

  static async countForOrganization(params: {
    organizationId: string;
    entityTypes?: DeletedItemEntityType[];
  }): Promise<number> {
    const types = params.entityTypes?.length
      ? params.entityTypes
      : DELETED_ITEM_ENTITY_TYPES;

    const counts = await Promise.all(
      types.map(async (entityType) => {
        const { table } = ENTITY_REGISTRY[entityType];
        const [row] = await db
          .select({ value: sql<number>`count(*)::int` })
          .from(table)
          .where(deletedInOrg(table, params.organizationId));
        return row?.value ?? 0;
      }),
    );

    return counts.reduce((total, value) => total + value, 0);
  }

  /**
   * One soft-deleted row, org-scoped. Returns null for an active row, an
   * unknown id, or another organization's row alike — the caller cannot tell
   * those apart, which is what keeps a cross-tenant probe uninformative.
   */
  static async findOne(params: {
    entityType: DeletedItemEntityType;
    id: string;
    organizationId: string;
  }): Promise<DeletedItem | null> {
    const { table, nameColumn, restorable } =
      ENTITY_REGISTRY[params.entityType];
    const [row] = await db
      .select({
        id: table.id,
        name: nameColumn as never,
        deletedAt: table.deletedAt,
      })
      .from(table)
      .where(
        and(
          eq(table.id as never, params.id),
          deletedInOrg(table, params.organizationId),
        ),
      )
      .limit(1);

    if (!row) return null;

    return {
      entityType: params.entityType,
      id: String(row.id),
      name: (row.name as string | null) ?? null,
      deletedAt: row.deletedAt as Date,
      restorable,
    };
  }

  /**
   * Ids of rows soft-deleted before `before`, oldest first — the retention
   * sweep's work list. Oldest-first so a capped run always makes progress on
   * the longest-waiting rows instead of revisiting the same recent ones.
   */
  static async listPurgeableBefore(params: {
    organizationId: string;
    entityType: DeletedItemEntityType;
    before: Date;
    limit: number;
  }): Promise<string[]> {
    const { table } = ENTITY_REGISTRY[params.entityType];
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          deletedInOrg(table, params.organizationId),
          lt(table.deletedAt, params.before),
        ),
      )
      .orderBy(table.deletedAt)
      .limit(params.limit);

    return rows.map((row) => String(row.id));
  }

  /**
   * Clear a `ON DELETE SET NULL` reference to a row about to be purged, in
   * bounded batches, so Postgres does not have to do it in one statement.
   *
   * This is what keeps purging an agent from stalling the LLM proxy. Deleting
   * an agent row makes Postgres synchronously NULL `interactions.profile_id` on
   * every historical interaction that agent ever produced — potentially
   * millions of rows on the platform's most write-hot table, inside the delete's
   * transaction, holding locks the proxy's own writes queue behind. Draining the
   * reference first in small committed batches reaches exactly the same end
   * state (the FK's own action then finds nothing left to do), but as many short
   * transactions instead of one long one.
   *
   * Returns how many rows were nulled and whether the reference is fully
   * drained; `drained: false` means `maxBatches` ran out and the caller should
   * leave the row for the next sweep rather than attempt the delete.
   */
  static async drainReferences(params: {
    table: PgTable;
    column: PgColumn;
    value: string;
    batchSize: number;
    maxBatches: number;
  }): Promise<{ nulled: number; drained: boolean }> {
    const { table, column, value, batchSize, maxBatches } = params;
    const idColumn = (table as unknown as { id: PgColumn }).id;
    // `.set()` is keyed by the Drizzle property name, not the SQL column name,
    // and silently emits an empty SET for an unrecognized key — so resolve the
    // property rather than passing `column.name` (`profile_id`) straight through.
    const columns = getTableColumns(table);
    const property = Object.keys(columns).find(
      (key) => columns[key].name === column.name,
    );
    if (!property) {
      throw new Error(
        `drainReferences: ${column.name} is not a column of the given table`,
      );
    }
    let nulled = 0;

    for (let batch = 0; batch < maxBatches; batch++) {
      const rows = await db
        .select({ id: idColumn })
        .from(table)
        .where(eq(column, value))
        .limit(batchSize);

      if (rows.length === 0) return { nulled, drained: true };

      await db
        .update(table)
        .set({ [property]: null })
        .where(
          inArray(
            idColumn,
            rows.map((row) => row.id),
          ),
        );
      nulled += rows.length;
    }

    // One more probe: the final batch may have emptied the reference exactly.
    const [remaining] = await db
      .select({ id: idColumn })
      .from(table)
      .where(eq(column, value))
      .limit(1);

    return { nulled, drained: !remaining };
  }

  /**
   * Physically remove one soft-deleted row. Scoped to `deleted_at IS NOT NULL`
   * so a restore that lands between the caller's read and this write cancels
   * the purge instead of destroying a row the user just recovered.
   */
  static async hardDeleteById(params: {
    entityType: DeletedItemEntityType;
    id: string;
    organizationId: string;
    tx?: Transaction;
  }): Promise<boolean> {
    const { table } = ENTITY_REGISTRY[params.entityType];
    const count = await hardDelete(
      params.tx ?? db,
      table,
      and(
        eq(table.id as never, params.id),
        deletedInOrg(table, params.organizationId),
      ),
    );
    return count > 0;
  }
}

export default DeletedItemModel;

// ===== Internal helpers =====

function deletedInOrg(
  table: PgTable & SoftDeletableTable,
  organizationId: string,
): SQL | undefined {
  return and(
    eq(
      (table as unknown as { organizationId: never }).organizationId,
      organizationId,
    ),
    isNotNull(table.deletedAt),
  );
}
