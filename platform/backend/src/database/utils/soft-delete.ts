import { isNull, type SQL } from "drizzle-orm";
import { type AnyPgColumn, timestamp } from "drizzle-orm/pg-core";

// ============================================================
// Soft Delete Utility — Generic soft-delete support for Drizzle
// ============================================================
//
// Usage:
//   1. Add the column:   deletedAt: timestamp("deleted_at", { mode: "date" })
//   2. Filter queries:   where(and(notDeleted(table), ...conditions))
//   3. Soft delete:      await db.update(table).set({ deletedAt: new Date() })
//                        .where(and(eq(table.id, id), notDeleted(table)))
//   4. Restore:          await db.update(table).set({ deletedAt: null })
//                        .where(eq(table.id, id))

/**
 * Creates a `deleted_at` timestamp column to add to any pgTable schema.
 * null = active record, non-null = soft-deleted.
 */
export function deletedAtColumn() {
  return timestamp("deleted_at", { mode: "date" });
}

/**
 * SQL condition to exclude soft-deleted records.
 * Chain with `and()` in WHERE clauses.
 *
 * @example
 * ```ts
 * import { and, eq } from "drizzle-orm";
 * import { notDeleted } from "@/database/utils/soft-delete";
 *
 * const agents = await db.select()
 *   .from(schema.agentsTable)
 *   .where(and(
 *     notDeleted(schema.agentsTable),
 *     eq(schema.agentsTable.organizationId, orgId)
 *   ));
 * ```
 */
export function notDeleted(table: {
  deletedAt: AnyPgColumn;
}): SQL {
  return isNull(table.deletedAt);
}

/**
 * SQL condition to find only soft-deleted records.
 */
export function onlyDeleted(table: {
  deletedAt: AnyPgColumn;
}): SQL {
  return sql`${table.deletedAt} IS NOT NULL`;
}