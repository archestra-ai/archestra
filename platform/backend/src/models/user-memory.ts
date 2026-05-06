import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertUserMemory, UserMemory } from "@/types";

class UserMemoryModel {
  static async findAllForUser(
    userId: string,
    organizationId: string,
  ): Promise<UserMemory[]> {
    return db
      .select()
      .from(schema.userMemoriesTable)
      .where(
        and(
          eq(schema.userMemoriesTable.userId, userId),
          eq(schema.userMemoriesTable.organizationId, organizationId),
        ),
      )
      .orderBy(asc(schema.userMemoriesTable.createdAt));
  }

  static async findById(id: string, userId: string): Promise<UserMemory | undefined> {
    const [row] = await db
      .select()
      .from(schema.userMemoriesTable)
      .where(
        and(
          eq(schema.userMemoriesTable.id, id),
          eq(schema.userMemoriesTable.userId, userId),
        ),
      )
      .limit(1);
    return row;
  }

  static async create(data: InsertUserMemory): Promise<UserMemory> {
    const [row] = await db
      .insert(schema.userMemoriesTable)
      .values(data)
      .returning();
    return row;
  }

  static async update(
    id: string,
    userId: string,
    data: Partial<Pick<UserMemory, "title" | "content">>,
  ): Promise<UserMemory | undefined> {
    const [row] = await db
      .update(schema.userMemoriesTable)
      .set(data)
      .where(
        and(
          eq(schema.userMemoriesTable.id, id),
          eq(schema.userMemoriesTable.userId, userId),
        ),
      )
      .returning();
    return row;
  }

  static async delete(id: string, userId: string): Promise<boolean> {
    const result = await db
      .delete(schema.userMemoriesTable)
      .where(
        and(
          eq(schema.userMemoriesTable.id, id),
          eq(schema.userMemoriesTable.userId, userId),
        ),
      )
      .returning({ id: schema.userMemoriesTable.id });
    return result.length > 0;
  }
}

export default UserMemoryModel;
