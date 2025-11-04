import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  Conversation,
  ConversationWithMessages,
  InsertConversation,
  UpdateConversation,
} from "@/types";

class ConversationModel {
  static async create(data: InsertConversation): Promise<Conversation> {
    const [conversation] = await db
      .insert(schema.conversationsTable)
      .values(data)
      .returning();

    return conversation;
  }

  static async findAll(
    userId: string,
    organizationId: string,
  ): Promise<Conversation[]> {
    const conversations = await db
      .select()
      .from(schema.conversationsTable)
      .where(
        and(
          eq(schema.conversationsTable.userId, userId),
          eq(schema.conversationsTable.organizationId, organizationId),
        ),
      )
      .orderBy(desc(schema.conversationsTable.updatedAt));

    return conversations;
  }

  static async findById(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<Conversation | null> {
    const [conversation] = await db
      .select()
      .from(schema.conversationsTable)
      .where(
        and(
          eq(schema.conversationsTable.id, id),
          eq(schema.conversationsTable.userId, userId),
          eq(schema.conversationsTable.organizationId, organizationId),
        ),
      );

    return conversation || null;
  }

  static async findByIdWithMessages(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<ConversationWithMessages | null> {
    const conversation = await ConversationModel.findById(
      id,
      userId,
      organizationId,
    );

    if (!conversation) {
      return null;
    }

    const messages = await db
      .select()
      .from(schema.messagesTable)
      .where(eq(schema.messagesTable.conversationId, id))
      .orderBy(schema.messagesTable.createdAt);

    return {
      ...conversation,
      messages: messages.map((msg) => msg.content),
    };
  }

  static async update(
    id: string,
    userId: string,
    organizationId: string,
    data: UpdateConversation,
  ): Promise<Conversation | null> {
    const [updated] = await db
      .update(schema.conversationsTable)
      .set(data)
      .where(
        and(
          eq(schema.conversationsTable.id, id),
          eq(schema.conversationsTable.userId, userId),
          eq(schema.conversationsTable.organizationId, organizationId),
        ),
      )
      .returning();

    return updated || null;
  }

  static async delete(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    await db
      .delete(schema.conversationsTable)
      .where(
        and(
          eq(schema.conversationsTable.id, id),
          eq(schema.conversationsTable.userId, userId),
          eq(schema.conversationsTable.organizationId, organizationId),
        ),
      );
  }
}

export default ConversationModel;
