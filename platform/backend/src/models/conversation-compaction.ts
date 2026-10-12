import { asc, desc, eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type { InsertConversationCompaction } from "@/types/conversation-compaction";

class ConversationCompactionModel {
  static async create(data: InsertConversationCompaction) {
    const [record] = await db
      .insert(schema.conversationCompactionsTable)
      .values(data)
      .returning();

    return record;
  }

  static async findLatestByConversation(conversationId: string) {
    const [record] = await db
      .select()
      .from(schema.conversationCompactionsTable)
      .where(
        eq(schema.conversationCompactionsTable.conversationId, conversationId),
      )
      .orderBy(desc(schema.conversationCompactionsTable.createdAt))
      .limit(1);

    return record ?? null;
  }

  static async findByConversation(conversationId: string) {
    return await db
      .select()
      .from(schema.conversationCompactionsTable)
      .where(
        eq(schema.conversationCompactionsTable.conversationId, conversationId),
      )
      .orderBy(asc(schema.conversationCompactionsTable.createdAt));
  }

  static async deleteByConversation(
    conversationId: string,
    executor: typeof db | Transaction = db,
  ): Promise<void> {
    await executor
      .delete(schema.conversationCompactionsTable)
      .where(
        eq(schema.conversationCompactionsTable.conversationId, conversationId),
      );
  }
}

export default ConversationCompactionModel;
