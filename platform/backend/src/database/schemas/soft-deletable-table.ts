import type { BuildColumns, BuildExtraConfigColumns } from "drizzle-orm";
import { isNull } from "drizzle-orm";
import {
  type AnyPgColumn,
  type PgColumnBuilderBase,
  type PgTableExtraConfigValue,
  type PgTableWithColumns,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Mixin spread into a `pgTable` column object (or applied automatically by
 * `softDeletablePgTable`) to opt a table into soft deletion. `deletedAt` is
 * NULL for active rows, non-NULL for soft-deleted ones.
 */
export const softDeleteColumns = {
  deletedAt: timestamp("deleted_at", { mode: "date" }),
};

export type SoftDeletableTable = {
  deletedAt: AnyPgColumn;
};

export const notDeleted = (table: SoftDeletableTable) =>
  isNull(table.deletedAt);

type WithSoftDelete<TColumnsMap extends Record<string, PgColumnBuilderBase>> =
  TColumnsMap & typeof softDeleteColumns;

/**
 * Wraps Drizzle's `pgTable` and adds the shared soft-delete column. Use this at
 * the schema definition site for tables whose rows should be soft-deletable.
 * The resulting table type exposes `deletedAt`, so `extraConfig` callbacks can
 * reference it in partial-index predicates.
 */
export function softDeletablePgTable<
  TTableName extends string,
  TColumnsMap extends Record<string, PgColumnBuilderBase>,
>(
  name: TTableName,
  columns: TColumnsMap,
  extraConfig?: (
    self: BuildExtraConfigColumns<
      TTableName,
      WithSoftDelete<TColumnsMap>,
      "pg"
    >,
  ) => PgTableExtraConfigValue[],
): PgTableWithColumns<{
  name: TTableName;
  schema: undefined;
  columns: BuildColumns<TTableName, WithSoftDelete<TColumnsMap>, "pg">;
  dialect: "pg";
}> {
  return pgTable(name, { ...columns, ...softDeleteColumns }, extraConfig);
}
