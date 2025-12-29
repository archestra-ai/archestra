import { and, desc, eq, getTableColumns } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  Conversation,
  InsertConversation,
  UpdateConversation,
} from "@/types";

class ConversationModel {
  static async create(data: InsertConversation): Promise<Conversation> {
    const [conversation] = await db
      .insert(schema.conversationsTable)
      .values(data)
      .returning();

    const conversationWithAgent = (await ConversationModel.findById({
      id: conversation.id,
      userId: data.userId,
      organizationId: data.organizationId,
    })) as Conversation;

    return conversationWithAgent;
  }

  static async findAll(
    userId: string,
    organizationId: string,
  ): Promise<Conversation[]> {
    const rows = await db
      .select({
        conversation: getTableColumns(schema.conversationsTable),
        message: getTableColumns(schema.messagesTable),
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
        },
      })
      .from(schema.conversationsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.conversationsTable.agentId, schema.agentsTable.id),
      )
      .leftJoin(
        schema.messagesTable,
        eq(schema.conversationsTable.id, schema.messagesTable.conversationId),
      )
      .where(
        and(
          eq(schema.conversationsTable.userId, userId),
          eq(schema.conversationsTable.organizationId, organizationId),
        ),
      )
      .orderBy(
        desc(schema.conversationsTable.createdAt),
        schema.messagesTable.createdAt,
      );

    // Group messages by conversation
    const conversationMap = new Map<string, Conversation>();

    for (const row of rows) {
      const conversationId = row.conversation.id;

      if (!conversationMap.has(conversationId)) {
        conversationMap.set(conversationId, {
          ...row.conversation,
          agent: row.agent,
          messages: [],
        });
      }

      const conversation = conversationMap.get(conversationId);
      if (conversation && row?.message?.content) {
        // Merge database UUID into message content (overrides AI SDK's temporary ID)
        conversation.messages.push({
          ...row.message.content,
          id: row.message.id,
        });
      }
    }

    return Array.from(conversationMap.values());
  }

  static async findById({
    id,
    userId,
    organizationId,
  }: {
    id: string;
    userId: string;
    organizationId: string;
  }): Promise<Conversation | null> {
    const rows = await db
      .select({
        conversation: getTableColumns(schema.conversationsTable),
        message: getTableColumns(schema.messagesTable),
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
        },
      })
      .from(schema.conversationsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.conversationsTable.agentId, schema.agentsTable.id),
      )
      .leftJoin(
        schema.messagesTable,
        eq(schema.conversationsTable.id, schema.messagesTable.conversationId),
      )
      .where(
        and(
          eq(schema.conversationsTable.id, id),
          eq(schema.conversationsTable.userId, userId),
          eq(schema.conversationsTable.organizationId, organizationId),
        ),
      )
      .orderBy(schema.messagesTable.createdAt);

    if (rows.length === 0) {
      return null;
    }

    const firstRow = rows[0];
    const messages = [];

    for (const row of rows) {
      if (row.message?.content) {
        // Merge database UUID into message content (overrides AI SDK's temporary ID)
        messages.push({
          ...row.message.content,
          id: row.message.id,
        });
      }
    }

    return {
      ...firstRow.conversation,
      agent: firstRow.agent,
      messages,
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

    if (!updated) {
      return null;
    }

    const updatedWithAgent = (await ConversationModel.findById({
      id: updated.id,
      userId: userId,
      organizationId: organizationId,
    })) as Conversation;

    return updatedWithAgent;
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
