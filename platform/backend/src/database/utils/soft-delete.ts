import { and, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  type AnyPgTable,
  timestamp,
} from "drizzle-orm/pg-core";
import type db from "@/database";
import type { Transaction } from "@/database";

type DbExecutor = Transaction | typeof db;

export function deletedAtColumn() {
  return timestamp("deleted_at", { mode: "date" });
}

export function notDeleted<
  TTable extends AnyPgTable & { deletedAt: AnyPgColumn },
>(table: TTable): SQL {
  return isNull(table.deletedAt);
}

export function onlyDeleted<
  TTable extends AnyPgTable & { deletedAt: AnyPgColumn },
>(table: TTable): SQL {
  return isNotNull(table.deletedAt);
}

export async function softDeleteById<
  TTable extends AnyPgTable & { deletedAt: AnyPgColumn; id: AnyPgColumn },
>(params: { table: TTable; id: string; tx?: DbExecutor }): Promise<boolean> {
  const { table, id } = params;
  const updateValues = {
    deletedAt: new Date(),
  } as Partial<TTable["$inferInsert"]>;
  const executor = params.tx ?? (await import("@/database")).default;

  const rows = await executor
    .update(table)
    .set(updateValues)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning({ id: table.id });

  return rows.length > 0;
}
