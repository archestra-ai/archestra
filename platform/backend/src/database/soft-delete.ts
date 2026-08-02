import { and, asc, isNull, not, type SQL, sql } from "drizzle-orm";
import type {
  AnyPgColumn,
  PgTable,
  PgUpdateSetSource,
} from "drizzle-orm/pg-core";
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
  // Optional explicit timestamp. A cascade (catalog + its installs + its tools)
  // passes one shared `at` so every stamped row shares an identical `deletedAt`,
  // which the corresponding restore uses as the correlation key to revive
  // exactly the rows this delete cascaded (and not rows deleted earlier).
  at: Date = new Date(),
): Promise<number> {
  // Reject undefined so callers can use `and(...)` without a non-null
  // assertion: a missing predicate would soft-delete every active row.
  if (!where) throw new Error("softDelete requires a where clause");

  const rows = await executor
    .update(table)
    .set({ deletedAt: at } as PgUpdateSetSource<T>)
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

/**
 * Predicate: the row has been soft-deleted for longer than `retentionDays`
 * (0 = any soft-deleted row). The cutoff is computed in SQL
 * (`now() - make_interval(...)`): `deleted_at` is `timestamp without time
 * zone`, and a JS Date parameter would shift by the host's UTC offset (same
 * rule as InteractionModel.deleteExpired).
 */
export const softDeleteExpired = (
  table: SoftDeletableTable,
  retentionDays: number,
): SQL =>
  sql`${table.deletedAt} < now()::timestamp - make_interval(days => ${retentionDays})`;

/**
 * Rows soft-deleted longer ago than `retentionDays`, oldest first — the purge
 * sweep's find-expired scan, served by the partial `*_deleted_at_purge_idx`
 * indexes. Rows with a NULL organization column are excluded: a purge without
 * a resolvable tenant would mean destroying data with no audit trail.
 */
export async function findExpiredSoftDeleted<T extends SoftDeletablePgTable>(
  executor: Executor,
  table: T,
  columns: { id: AnyPgColumn; organizationId: AnyPgColumn },
  params: { retentionDays: number; limit: number },
): Promise<{ id: string; organizationId: string }[]> {
  const rows = await executor
    .select({ id: columns.id, organizationId: columns.organizationId })
    .from(table as PgTable)
    .where(
      and(
        not(isNull(columns.organizationId)),
        softDeleteExpired(table, params.retentionDays),
      ),
    )
    .orderBy(asc(table.deletedAt))
    .limit(params.limit);
  return rows as { id: string; organizationId: string }[];
}

/**
 * Options shared by every purgeable model's `hardDelete`.
 * `onlyIfDeletedForDays` restricts the purge paths to aged-out soft-deleted
 * rows (see {@link lockRowForPurge}); `onPurged` runs inside the delete
 * transaction immediately after the row delete succeeds — the retention
 * sweep writes its purge audit row there, so a purge can never commit
 * without its audit trail (a failed write rolls the delete back and the
 * next sweep retries).
 */
export type HardDeleteOpts = {
  onlyIfDeletedForDays?: number;
  onPurged?: (tx: Transaction) => Promise<void>;
};

/**
 * Lock a row FOR UPDATE inside the caller's transaction and confirm it is
 * still hard-deletable. With `onlyIfDeletedForDays`, eligible means
 * soft-deleted longer ago than that many days (0 = any soft-deleted row) —
 * the re-check that makes a purge race-safe against a concurrent restore:
 * restore updates the row, so it either commits before this lock (the
 * re-check sees the live row and refuses) or blocks until the purge commits.
 * Without the option the row is locked unconditionally, for rollback flows
 * that hard-delete rows which were never soft-deleted.
 * Returns false when the row is missing or ineligible.
 */
export async function lockRowForPurge<T extends SoftDeletablePgTable>(
  tx: Transaction,
  table: T,
  where: SQL | undefined,
  opts?: { onlyIfDeletedForDays?: number },
): Promise<boolean> {
  if (!where) throw new Error("lockRowForPurge requires a where clause");

  const rows = await tx
    .select({ deletedAt: table.deletedAt })
    .from(table as PgTable)
    .where(
      opts?.onlyIfDeletedForDays === undefined
        ? where
        : and(where, softDeleteExpired(table, opts.onlyIfDeletedForDays)),
    )
    .limit(1)
    .for("update");
  return rows.length > 0;
}
