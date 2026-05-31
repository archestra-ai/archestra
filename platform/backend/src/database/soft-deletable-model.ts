import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import db, { type Transaction } from "@/database";
import {
  notDeleted,
  type SoftDeletableTable,
} from "@/database/schemas/soft-deletable-table";
import {
  hardDelete,
  restore as restoreHelper,
  softDelete,
} from "@/database/soft-delete";

type Executor = typeof db | Transaction;

type WithId = { id: PgColumn };

export interface SoftDeletableModelOptions {
  includeDeleted?: boolean;
}

/**
 * Generic CRUD over a soft-deletable table. Composes `notDeleted` into each
 * method; pass `{ includeDeleted: true }` to opt out where it applies.
 */
export class SoftDeletableModel<
  TTable extends PgTable & SoftDeletableTable & WithId,
> {
  protected readonly table: TTable;

  constructor(table: TTable) {
    this.table = table;
  }

  async findById(
    id: TTable["id"]["_"]["data"],
    opts: SoftDeletableModelOptions = {},
    tx?: Transaction,
  ): Promise<TTable["$inferSelect"] | null> {
    const executor: Executor = tx ?? db;
    const where = opts.includeDeleted
      ? eq(this.table.id, id as unknown as SQL | string | number)
      : and(
          eq(this.table.id, id as unknown as SQL | string | number),
          notDeleted(this.table),
        );
    const rows = await executor
      .select()
      .from(this.table as PgTable)
      .where(where);
    return (rows[0] as TTable["$inferSelect"]) ?? null;
  }

  async findAll(
    opts: SoftDeletableModelOptions = {},
    tx?: Transaction,
  ): Promise<TTable["$inferSelect"][]> {
    const executor: Executor = tx ?? db;
    const query = executor.select().from(this.table as PgTable);
    const rows = opts.includeDeleted
      ? await query
      : await query.where(notDeleted(this.table));
    return rows as TTable["$inferSelect"][];
  }

  async update(
    id: TTable["id"]["_"]["data"],
    data: PgUpdateSetSource<TTable>,
    tx?: Transaction,
  ): Promise<TTable["$inferSelect"] | null> {
    const executor: Executor = tx ?? db;
    const rows = await executor
      .update(this.table)
      .set(data)
      .where(
        and(
          eq(this.table.id, id as unknown as SQL | string | number),
          notDeleted(this.table),
        ),
      )
      .returning();
    return ((rows as TTable["$inferSelect"][])[0] ?? null) as
      | TTable["$inferSelect"]
      | null;
  }

  async delete(
    id: TTable["id"]["_"]["data"],
    tx?: Transaction,
  ): Promise<boolean> {
    const count = await softDelete(
      tx ?? db,
      this.table,
      eq(this.table.id, id as unknown as SQL | string | number),
    );
    return count > 0;
  }

  async hardDelete(
    id: TTable["id"]["_"]["data"],
    tx?: Transaction,
  ): Promise<boolean> {
    const count = await hardDelete(
      tx ?? db,
      this.table,
      eq(this.table.id, id as unknown as SQL | string | number),
    );
    return count > 0;
  }

  async restore(
    id: TTable["id"]["_"]["data"],
    tx?: Transaction,
  ): Promise<boolean> {
    const count = await restoreHelper(
      tx ?? db,
      this.table,
      eq(this.table.id, id as unknown as SQL | string | number),
    );
    return count > 0;
  }
}
