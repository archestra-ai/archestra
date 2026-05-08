import { TOOL_STATE } from "@shared";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertMessage, Message } from "@/types";

class MessageModel {
  /**
   * Update the conversation's updatedAt timestamp when messages are added.
   * This ensures conversations are sorted by latest message activity.
   */
  private static async touchConversation(
    conversationId: string,
  ): Promise<void> {
    await db
      .update(schema.conversationsTable)
      .set({ updatedAt: new Date() })
      .where(eq(schema.conversationsTable.id, conversationId));
  }

  static async create(data: InsertMessage): Promise<Message> {
    const [message] = await db
      .insert(schema.messagesTable)
      .values(data)
      .returning();

    // Update conversation's updatedAt so it sorts to the top
    await MessageModel.touchConversation(data.conversationId);

    return message;
  }

  static async bulkCreate(messages: InsertMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    await db.insert(schema.messagesTable).values(messages);

    // Update conversation's updatedAt for all affected conversations
    const uniqueConversationIds = [
      ...new Set(messages.map((m) => m.conversationId)),
    ];
    await Promise.all(
      uniqueConversationIds.map((id) => MessageModel.touchConversation(id)),
    );
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

  static async bulkDelete(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await db
      .delete(schema.messagesTable)
      .where(inArray(schema.messagesTable.id, messageIds));
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

  /**
   * Find a message by the AI SDK content ID stored in the JSONB content field.
   * This handles in-session messages whose IDs haven't been replaced with DB UUIDs yet.
   */
  static async findByContentId(contentId: string): Promise<Message | null> {
    const [message] = await db
      .select()
      .from(schema.messagesTable)
      .where(sql`${schema.messagesTable.content}->>'id' = ${contentId}`);

    return message || null;
  }

  /**
   * Find a message by either its database UUID or AI SDK content ID.
   * Messages loaded from DB have UUID IDs, but messages created in the current
   * session retain their AI SDK nanoid IDs until the page is reloaded.
   */
  static async findByAnyId(id: string): Promise<Message | null> {
    // Try DB UUID first (fast indexed lookup) — only if it looks like a UUID
    // to avoid PostgreSQL "invalid input syntax for type uuid" errors
    if (UUID_REGEX.test(id)) {
      const byDbId = await MessageModel.findById(id);
      if (byDbId) return byDbId;
    }

    // Fall back to content ID (AI SDK nanoid)
    return MessageModel.findByContentId(id);
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
   * Find every prior assistant message in this conversation whose JSONB
   * content contains a tool part with the given toolCallId in
   * `approval-requested` state. Used by the persistence sweep to remove stale
   * rows so `tool_use` ids stay unique across the conversation. Returns all
   * matches so legacy buggy state with two stale rows for the same toolCallId
   * heals in a single sweep instead of one row per terminal event.
   */
  static async findPriorApprovalRequestedByToolCallId(params: {
    conversationId: string;
    toolCallId: string;
  }): Promise<Message[]> {
    const { conversationId, toolCallId } = params;
    return await db
      .select()
      .from(schema.messagesTable)
      .where(
        and(
          eq(schema.messagesTable.conversationId, conversationId),
          sql`EXISTS (
            SELECT 1
            FROM jsonb_array_elements(${schema.messagesTable.content}->'parts') AS part
            WHERE part->>'type' LIKE 'tool-%'
              AND part->>'toolCallId' = ${toolCallId}
              AND part->>'state' = ${TOOL_STATE.APPROVAL_REQUESTED}
          )`,
        ),
      )
      .orderBy(schema.messagesTable.createdAt)
      // Defensive cap: realistic invariant is at most one stale row per
      // (conversationId, toolCallId). 100 is large enough to absorb any
      // legitimate legacy heal scenario, small enough to fail visibly if
      // that invariant ever breaks rather than OOM the request handler.
      .limit(100);
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

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
