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

    const conversationWithAgent = (await ConversationModel.findById(
      conversation.id,
      data.userId,
      data.organizationId,
    )) as Conversation;

    return conversationWithAgent;
  }

  static async findAll(
    userId: string,
    organizationId: string,
  ): Promise<Conversation[]> {
    const rows = await db
      .select({
        conversation: getTableColumns(schema.conversationsTable),
        messages: schema.messagesTable.content,
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
      .orderBy(desc(schema.conversationsTable.createdAt));

    const conversations = rows.map((row) => ({
      ...row.conversation,
      agent: row.agent,
      messages: row.messages,
    }));

    return conversations;
  }

  static async findById(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<Conversation | null> {
    const [conversation] = await db
      .select({
        ...getTableColumns(schema.conversationsTable),
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
        },
        messages: schema.messagesTable.content,
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
      );

    return conversation;
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

    const updatedWithAgent = (await ConversationModel.findById(
      updated.id,
      userId,
      organizationId,
    )) as Conversation;

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
