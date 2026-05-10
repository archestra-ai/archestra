import { and, eq, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/_soft-delete";
import { hardDelete, softDelete } from "@/database/soft-delete";
import type { A2AContext, InsertA2AContext } from "@/types";

class A2AContextModel {
  static async create(data: InsertA2AContext): Promise<A2AContext> {
    const [context] = await db
      .insert(schema.a2aContextsTable)
      .values(data)
      .returning();

    return context;
  }

  static async findById(id: string): Promise<A2AContext | null> {
    const [context] = await db
      .select()
      .from(schema.a2aContextsTable)
      .where(
        and(
          eq(schema.a2aContextsTable.id, id),
          notDeleted(schema.a2aContextsTable),
        ),
      )
      .limit(1);

    return context ?? null;
  }

  static async delete(id: string, tx?: Transaction): Promise<void> {
    await softDelete(
      tx ?? db,
      schema.a2aContextsTable,
      eq(schema.a2aContextsTable.id, id),
    );
  }

  static async hardDelete(id: string, tx?: Transaction): Promise<void> {
    await hardDelete(
      tx ?? db,
      schema.a2aContextsTable,
      eq(schema.a2aContextsTable.id, id),
    );
  }

  static async getTotalCount(): Promise<number> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(${schema.a2aContextsTable.id})` })
      .from(schema.a2aContextsTable)
      .where(notDeleted(schema.a2aContextsTable));

    return Number(count);
  }
}

export default A2AContextModel;
