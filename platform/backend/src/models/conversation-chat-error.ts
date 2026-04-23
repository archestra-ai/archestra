import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ConversationChatError,
  InsertConversationChatError,
} from "@/types";

class ConversationChatErrorModel {
  static async create(
    data: InsertConversationChatError,
  ): Promise<ConversationChatError> {
    const [chatError] = await db
      .insert(schema.conversationChatErrorsTable)
      .values(data)
      .returning();

    return chatError;
  }

  static async findByConversation(
    conversationId: string,
  ): Promise<ConversationChatError[]> {
    return await db
      .select()
      .from(schema.conversationChatErrorsTable)
      .where(
        eq(schema.conversationChatErrorsTable.conversationId, conversationId),
      )
      .orderBy(schema.conversationChatErrorsTable.createdAt);
  }
}

export default ConversationChatErrorModel;
