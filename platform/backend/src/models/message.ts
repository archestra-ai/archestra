import { and, eq, gt } from "drizzle-orm";
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

  static async findById(messageId: string): Promise<Message | null> {
    const [message] = await db
      .select()
      .from(schema.messagesTable)
      .where(eq(schema.messagesTable.id, messageId));

    return message || null;
  }

  static async updateTextPart(
    messageId: string,
    partIndex: number,
    newText: string,
  ): Promise<Message> {
    // Fetch the current message
    const message = await MessageModel.findById(messageId);

    if (!message) {
      throw new Error("Message not found");
    }

    // biome-ignore lint/suspicious/noExplicitAny: UIMessage content is dynamic
    const content = message.content as any;

    // Validate that the part exists
    if (!content.parts?.[partIndex]) {
      throw new Error("Invalid part index");
    }

    // Validate that the part is a text part to prevent data corruption
    // Only text parts can have their text property modified
    if (content.parts[partIndex].type !== "text") {
      throw new Error(
        `Cannot update non-text part: part at index ${partIndex} is of type "${content.parts[partIndex].type}"`,
      );
    }

    // Update the specific part's text
    content.parts[partIndex].text = newText;

    // Update the message in the database
    const [updatedMessage] = await db
      .update(schema.messagesTable)
      .set({
        content,
        updatedAt: new Date(),
      })
      .where(eq(schema.messagesTable.id, messageId))
      .returning();

    return updatedMessage;
  }

  static async deleteAfterMessage(
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    // Get the message to find its createdAt timestamp
    const message = await MessageModel.findById(messageId);
    if (!message) {
      throw new Error("Message not found");
    }

    // Verify the message belongs to the specified conversation to prevent
    // accidentally deleting messages from a different conversation
    if (message.conversationId !== conversationId) {
      throw new Error("Message does not belong to the specified conversation");
    }

    // Delete all messages in this conversation created after this message
    await db
      .delete(schema.messagesTable)
      .where(
        and(
          eq(schema.messagesTable.conversationId, conversationId),
          gt(schema.messagesTable.createdAt, message.createdAt),
        ),
      );
  }

  /**
   * Update a text part and optionally delete subsequent messages atomically.
   * Uses a transaction to ensure both operations succeed or fail together.
   */
  static async updateTextPartAndDeleteSubsequent(
    messageId: string,
    partIndex: number,
    newText: string,
    deleteSubsequent: boolean,
  ): Promise<Message> {
    return await db.transaction(async (tx) => {
      // Fetch the current message within transaction
      const [message] = await tx
        .select()
        .from(schema.messagesTable)
        .where(eq(schema.messagesTable.id, messageId));

      if (!message) {
        throw new Error("Message not found");
      }

      // biome-ignore lint/suspicious/noExplicitAny: UIMessage content is dynamic
      const content = message.content as any;

      // Validate that the part exists
      if (!content.parts?.[partIndex]) {
        throw new Error("Invalid part index");
      }

      // Validate that the part is a text part to prevent data corruption
      if (content.parts[partIndex].type !== "text") {
        throw new Error(
          `Cannot update non-text part: part at index ${partIndex} is of type "${content.parts[partIndex].type}"`,
        );
      }

      // Update the specific part's text
      content.parts[partIndex].text = newText;

      // Update the message in the database
      const [updatedMessage] = await tx
        .update(schema.messagesTable)
        .set({
          content,
          updatedAt: new Date(),
        })
        .where(eq(schema.messagesTable.id, messageId))
        .returning();

      // Delete subsequent messages if requested
      if (deleteSubsequent) {
        await tx
          .delete(schema.messagesTable)
          .where(
            and(
              eq(schema.messagesTable.conversationId, message.conversationId),
              gt(schema.messagesTable.createdAt, message.createdAt),
            ),
          );
      }

      return updatedMessage;
    });
  }
}

export default MessageModel;
