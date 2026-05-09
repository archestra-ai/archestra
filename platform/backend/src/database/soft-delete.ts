import { and, isNull, not, type SQL } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type db from "@/database";
import type { Transaction } from "@/database";
import type { SoftDeletableTable } from "@/database/schemas/_soft-delete";

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
  where: SQL,
): Promise<number> {
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
  where: SQL,
): Promise<number> {
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
  where: SQL,
): Promise<number> {
  const rows = await executor.delete(table).where(where).returning();
  return rows.length;
}
