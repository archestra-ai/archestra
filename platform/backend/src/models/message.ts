import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import { ApiError, type InsertMessage, type Message } from "@/types";
import { isUuid, uuidv7 } from "@/utils/uuid";

type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

class MessageModel {
  /**
   * Update the conversation's timestamps when messages are added.
   *
   * `lastMessageAt` is forced strictly past `lastReadAt` when the two would
   * otherwise land on the same millisecond: the unread check is a strict
   * `lastMessageAt > lastReadAt` comparison, so a message racing markRead
   * into the same instant would silently read as already-seen. GREATEST with
   * a 1ms nudge keeps the invariant "written after a read ⇒ unread" without
   * needing a sequence column.
   */
  private static async touchConversation(
    conversationId: string,
    executor: DbExecutor = db,
  ): Promise<void> {
    await executor
      .update(schema.conversationsTable)
      .set({
        updatedAt: new Date(),
        lastMessageAt: sql`GREATEST(${new Date()}::timestamp, ${schema.conversationsTable.lastReadAt} + interval '1 millisecond')`,
      })
      .where(eq(schema.conversationsTable.id, conversationId));
  }

  static async create(data: InsertMessage): Promise<Message> {
    const [message] = await db
      .insert(schema.messagesTable)
      // Monotonic v7 id: with `created_at` at millisecond precision,
      // back-to-back writes can tie, and every "which message is later?"
      // question (ordering, delete-subsequent) breaks ties with the id.
      .values({ id: uuidv7(), ...data })
      .returning();

    // Update conversation's updatedAt so it sorts to the top
    await MessageModel.touchConversation(data.conversationId);

    return message;
  }

  static async bulkCreate(
    messages: InsertMessage[],
    executor: DbExecutor = db,
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    await executor
      .insert(schema.messagesTable)
      .values(messages.map((m) => ({ id: uuidv7(), ...m })));

    // Update conversation's updatedAt for all affected conversations. Must run
    // on the same executor: with a transaction executor, a separate `db` query
    // would escape the transaction (and deadlock single-connection PGlite).
    const uniqueConversationIds = [
      ...new Set(messages.map((m) => m.conversationId)),
    ];
    await Promise.all(
      uniqueConversationIds.map((id) =>
        MessageModel.touchConversation(id, executor),
      ),
    );
  }

  static async findByConversation(conversationId: string): Promise<Message[]> {
    const messages = await db
      .select()
      .from(schema.messagesTable)
      .where(eq(schema.messagesTable.conversationId, conversationId))
      .orderBy(schema.messagesTable.createdAt, schema.messagesTable.id);

    return messages;
  }

  /** Cheap emptiness probe — avoids loading full rows just to count them. */
  static async existsForConversation(conversationId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.messagesTable.id })
      .from(schema.messagesTable)
      .where(eq(schema.messagesTable.conversationId, conversationId))
      .limit(1);

    return row !== undefined;
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
    if (isUuid(id)) {
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
      throw new ApiError(404, "Message not found");
    }

    // biome-ignore lint/suspicious/noExplicitAny: UIMessage content is dynamic
    const content = message.content as any;

    // Validate that the part exists
    if (!content.parts?.[partIndex]) {
      throw new ApiError(400, "Invalid part index");
    }

    // Validate that the part is a text part to prevent data corruption
    // Only text parts can have their text property modified
    if (content.parts[partIndex].type !== "text") {
      throw new ApiError(
        400,
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

  /**
   * Replace a message's full content. Used when a turn changes after it was
   * first persisted — e.g. a tool call that has since been approved or declined.
   */
  static async updateContent(
    messageId: string,
    content: Message["content"],
  ): Promise<Message> {
    // Validate the row exists so the return type holds — `.returning()`
    // would otherwise yield `undefined` for an unknown id.
    const message = await MessageModel.findById(messageId);
    if (!message) {
      throw new Error("Message not found");
    }

    const [updatedMessage] = await db
      .update(schema.messagesTable)
      .set({
        content,
        updatedAt: new Date(),
      })
      .where(eq(schema.messagesTable.id, messageId))
      .returning();

    // A content change (e.g. a tool call's final output landing in an existing
    // assistant message) is fresh activity the owner may not have seen, so it
    // advances the conversation's recency the same way a new message does.
    await MessageModel.touchConversation(updatedMessage.conversationId);

    return updatedMessage;
  }

  /**
   * Hard-delete the given message rows by their primary keys. Accepts an
   * optional executor so a regenerate can delete the stale trailing turn and
   * persist its replacement in one transaction. Deletion is by identity (id),
   * never by a timestamp window, so colliding `createdAt` values can't cause
   * the wrong rows to be removed.
   */
  static async deleteByIds(
    ids: string[],
    executor: DbExecutor = db,
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const rows = await executor
      .delete(schema.messagesTable)
      .where(inArray(schema.messagesTable.id, ids))
      .returning({ id: schema.messagesTable.id });

    return rows.length;
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
          MessageModel.createdAfter(message),
        ),
      );
  }

  /**
   * Update a text part and optionally delete subsequent messages atomically.
   * Accepts an optional executor so callers can compose this with other writes
   * (e.g. compaction invalidation) inside a single outer transaction.
   */
  static async updateTextPartAndDeleteSubsequent(
    messageId: string,
    partIndex: number,
    newText: string,
    deleteSubsequent: boolean,
    executor: DbExecutor = db,
  ): Promise<Message> {
    const run = async (tx: DbExecutor): Promise<Message> => {
      const [message] = await tx
        .select()
        .from(schema.messagesTable)
        .where(eq(schema.messagesTable.id, messageId));

      if (!message) {
        throw new ApiError(404, "Message not found");
      }

      // biome-ignore lint/suspicious/noExplicitAny: UIMessage content is dynamic
      const content = message.content as any;

      // Validate that the part exists
      if (!content.parts?.[partIndex]) {
        throw new ApiError(400, "Invalid part index");
      }

      // Validate that the part is a text part to prevent data corruption
      if (content.parts[partIndex].type !== "text") {
        throw new ApiError(
          400,
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
              MessageModel.createdAfter(message),
            ),
          );
      }

      return updatedMessage;
    };

    // when no outer transaction is provided, wrap so update + delete remain atomic
    if (executor === db) {
      return await withDbTransaction(async (tx) => run(tx));
    }
    return await run(executor);
  }

  /**
   * Rows that come after `message` in the canonical conversation order,
   * `(created_at, id)`. A strict `created_at >` comparison alone misses
   * same-millisecond neighbours (back-to-back writes routinely tie), so
   * "subsequent" is the tuple comparison that matches exactly what
   * findByConversation displays. New ids are monotonic UUIDv7, so for
   * fresh data the id tiebreak IS insertion order.
   */
  private static createdAfter(message: Pick<Message, "id" | "createdAt">) {
    return or(
      gt(schema.messagesTable.createdAt, message.createdAt),
      and(
        eq(schema.messagesTable.createdAt, message.createdAt),
        gt(schema.messagesTable.id, message.id),
      ),
    );
  }
}

export default MessageModel;
