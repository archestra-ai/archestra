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
 * `softPgTable`) to mark the table as soft-deletable. `deletedAt` is NULL
 * for active rows, non-NULL for soft-deleted ones.
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
 * Wraps drizzle's `pgTable` so every soft-deletable table opts in via the
 * call site instead of spreading `...softDeleteColumns` into its column
 * object. The resulting table type still exposes `deletedAt`, so the
 * `extraConfig` callback can reference it in partial-index predicates.
 */
export function softPgTable<
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
