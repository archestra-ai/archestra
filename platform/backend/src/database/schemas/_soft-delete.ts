import { isNull } from "drizzle-orm";
import { type AnyPgColumn, timestamp } from "drizzle-orm/pg-core";

/**
 * Spread into a `pgTable` column object to mark the table as soft-deletable.
 * `deletedAt` is NULL for active rows, non-NULL for soft-deleted ones.
 */
export const softDeleteColumns = {
  deletedAt: timestamp("deleted_at", { mode: "date" }),
};

export type SoftDeletableTable = {
  deletedAt: AnyPgColumn;
};

export const notDeleted = (table: SoftDeletableTable) =>
  isNull(table.deletedAt);
