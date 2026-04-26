import { desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ConversationCompaction,
  InsertConversationCompaction,
} from "@/types";

class ConversationCompactionModel {
  static async create(
    data: InsertConversationCompaction,
  ): Promise<ConversationCompaction> {
    const [compaction] = await db
      .insert(schema.conversationCompactionsTable)
      .values(data)
      .returning();

    return compaction;
  }

  /**
   * Returns the most recent compaction for a conversation, or null if none exists.
   * Used to re-inject the latest summary at the start of each chat turn.
   */
  static async findLatestByConversation(
    conversationId: string,
  ): Promise<ConversationCompaction | null> {
    const [compaction] = await db
      .select()
      .from(schema.conversationCompactionsTable)
      .where(
        eq(schema.conversationCompactionsTable.conversationId, conversationId),
      )
      .orderBy(desc(schema.conversationCompactionsTable.createdAt))
      .limit(1);

    return compaction ?? null;
  }

  /**
   * Returns all compactions for a conversation in chronological order.
   * Useful for building a chain of summaries over very long sessions.
   */
  static async findAllByConversation(
    conversationId: string,
  ): Promise<ConversationCompaction[]> {
    return await db
      .select()
      .from(schema.conversationCompactionsTable)
      .where(
        eq(schema.conversationCompactionsTable.conversationId, conversationId),
      )
      .orderBy(schema.conversationCompactionsTable.createdAt);
  }
}

export default ConversationCompactionModel;
