import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertMessage, Message } from "@/types";

class MessageModel {
  static async create(data: InsertMessage): Promise<Message> {
    const [message] = await db
      .insert(schema.messagesTable)
      .values(data)
      .returning();

    return message;
  }

  static async bulkCreate(messages: InsertMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    await db.insert(schema.messagesTable).values(messages);
  }

  static async findByConversation(conversationId: string): Promise<Message[]> {
    const messages = await db
      .select()
      .from(schema.messagesTable)
      .where(eq(schema.messagesTable.conversationId, conversationId))
      .orderBy(schema.messagesTable.createdAt);

    return messages;
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.messagesTable)
      .where(eq(schema.messagesTable.id, id));
  }

  static async deleteByConversation(conversationId: string): Promise<void> {
    await db
      .delete(schema.messagesTable)
      .where(eq(schema.messagesTable.conversationId, conversationId));
  }
}

export default MessageModel;
