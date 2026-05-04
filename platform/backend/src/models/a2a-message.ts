import { desc, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { A2AMessage, InsertA2AMessage } from "@/types";

class A2AMessageModel {
  private static async touchContext(contextId: string): Promise<void> {
    await db
      .update(schema.a2aContextsTable)
      .set({ updatedAt: new Date() })
      .where(eq(schema.a2aContextsTable.id, contextId));
  }

  static async create(data: InsertA2AMessage): Promise<A2AMessage> {
    const [message] = await db
      .insert(schema.a2aMessagesTable)
      .values(data)
      .returning();

    await A2AMessageModel.touchContext(data.contextId);

    return message;
  }

  static async bulkCreate(messages: InsertA2AMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    await db.insert(schema.a2aMessagesTable).values(messages);

    // Update context's updatedAt for all affected contexts
    const uniqueContextIds = [...new Set(messages.map((m) => m.contextId))];
    await Promise.all(
      uniqueContextIds.map((id) => A2AMessageModel.touchContext(id)),
    );
  }

  static async updateContent(id: string, content: unknown): Promise<void> {
    await db
      .update(schema.a2aMessagesTable)
      .set({ content, updatedAt: new Date() })
      .where(eq(schema.a2aMessagesTable.id, id));
  }

  static async updateContentAndParts(
    id: string,
    content: unknown,
    parts: unknown[],
  ): Promise<void> {
    await db
      .update(schema.a2aMessagesTable)
      .set({ content, parts, updatedAt: new Date() })
      .where(eq(schema.a2aMessagesTable.id, id));
  }

  static async findById(id: string): Promise<A2AMessage | null> {
    const [message] = await db
      .select()
      .from(schema.a2aMessagesTable)
      .where(eq(schema.a2aMessagesTable.id, id))
      .limit(1);

    return message ?? null;
  }

  static async findLastByContextId(
    contextId: string,
  ): Promise<A2AMessage | null> {
    const [message] = await db
      .select()
      .from(schema.a2aMessagesTable)
      .where(eq(schema.a2aMessagesTable.contextId, contextId))
      .orderBy(desc(schema.a2aMessagesTable.createdAt))
      .limit(1);

    return message ?? null;
  }

  static async findLastByTaskId(taskId: string): Promise<A2AMessage | null> {
    const [message] = await db
      .select()
      .from(schema.a2aMessagesTable)
      .where(eq(schema.a2aMessagesTable.taskId, taskId))
      .orderBy(desc(schema.a2aMessagesTable.createdAt))
      .limit(1);

    return message ?? null;
  }

  static async findByContextId(contextId: string): Promise<A2AMessage[]> {
    const messages = await db
      .select()
      .from(schema.a2aMessagesTable)
      .where(eq(schema.a2aMessagesTable.contextId, contextId))
      .orderBy(schema.a2aMessagesTable.createdAt);

    return messages;
  }

  static async findByTaskId(taskId: string): Promise<A2AMessage[]> {
    const messages = await db
      .select()
      .from(schema.a2aMessagesTable)
      .where(eq(schema.a2aMessagesTable.taskId, taskId))
      .orderBy(schema.a2aMessagesTable.createdAt);

    return messages;
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.a2aMessagesTable)
      .where(eq(schema.a2aMessagesTable.id, id));
  }

  static async getTotalCount(): Promise<number> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(${schema.a2aMessagesTable.id})` })
      .from(schema.a2aMessagesTable);

    return Number(count);
  }
}

export default A2AMessageModel;
