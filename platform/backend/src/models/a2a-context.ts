import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
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
      .where(eq(schema.a2aContextsTable.id, id))
      .limit(1);

    return context ?? null;
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.a2aContextsTable)
      .where(eq(schema.a2aContextsTable.id, id));
  }

  static async getTotalCount(): Promise<number> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(${schema.a2aContextsTable.id})` })
      .from(schema.a2aContextsTable);

    return Number(count);
  }
}

export default A2AContextModel;
