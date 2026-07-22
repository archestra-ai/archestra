import { and, isNull, not, type SQL, sql } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type db from "@/database";
import type { Transaction } from "@/database";
import type { SoftDeletableTable } from "@/database/schemas/soft-deletable-table";

type Executor = typeof db | Transaction;
type SoftDeletablePgTable = PgTable & SoftDeletableTable;

/**
 * Stamp `deletedAt = now()` on matching active rows. Idempotent — rows
 * already soft-deleted are not re-stamped. Returns the number of rows that
 * transitioned from active to soft-deleted.
 */
export async function softDelete<T extends SoftDeletablePgTable>(
  executor: Executor,
  table: T,
  where: SQL | undefined,
): Promise<number> {
  // Reject undefined so callers can use `and(...)` without a non-null
  // assertion: a missing predicate would soft-delete every active row.
  if (!where) throw new Error("softDelete requires a where clause");

  const rows = await executor
    .update(table)
    .set({ deletedAt: new Date() } as PgUpdateSetSource<T>)
    .where(and(where, isNull(table.deletedAt)))
    .returning({ deletedAt: table.deletedAt });

  return rows.length;
}

/**
 * Clear `deletedAt` on matching soft-deleted rows.
 */
export async function restore<T extends SoftDeletablePgTable>(
  executor: Executor,
  table: T,
  where: SQL | undefined,
): Promise<number> {
  if (!where) throw new Error("restore requires a where clause");

  const rows = await executor
    .update(table)
    .set({ deletedAt: null } as PgUpdateSetSource<T>)
    .where(and(where, not(isNull(table.deletedAt))))
    .returning({ deletedAt: table.deletedAt });

  return rows.length;
}

/**
 * Physically delete matching rows. Reserved for tables excluded from soft
 * delete, data-purge flows, and test/dev cleanup.
 */
export async function hardDelete<T extends PgTable>(
  executor: Executor,
  table: T,
  where: SQL | undefined,
): Promise<number> {
  if (!where) throw new Error("hardDelete requires a where clause");

  // Constant projection: the rows are only counted, so don't ship every
  // column of every deleted row back over the wire.
  const rows = await executor
    .delete(table)
    .where(where)
    .returning({ _: sql`1` });
  return rows.length;
}
