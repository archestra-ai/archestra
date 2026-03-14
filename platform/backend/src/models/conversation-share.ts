import { and, eq, getTableColumns } from "drizzle-orm";
import db, { schema } from "@/database";
import type { Conversation, ConversationShare } from "@/types";

class ConversationShareModel {
  static async findByConversationId(params: {
    conversationId: string;
    organizationId: string;
  }): Promise<ConversationShare | null> {
    const [share] = await db
      .select()
      .from(schema.conversationSharesTable)
      .where(
        and(
          eq(
            schema.conversationSharesTable.conversationId,
            params.conversationId,
          ),
          eq(
            schema.conversationSharesTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .limit(1);

    return share ?? null;
  }

  static async findByShareId(params: {
    shareId: string;
    organizationId: string;
  }): Promise<ConversationShare | null> {
    const [share] = await db
      .select()
      .from(schema.conversationSharesTable)
      .where(
        and(
          eq(schema.conversationSharesTable.id, params.shareId),
          eq(
            schema.conversationSharesTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .limit(1);

    return share ?? null;
  }

  static async create(params: {
    conversationId: string;
    organizationId: string;
    createdByUserId: string;
    visibility: "organization";
  }): Promise<ConversationShare> {
    const [share] = await db
      .insert(schema.conversationSharesTable)
      .values(params)
      .returning();

    return share;
  }

  static async delete(params: {
    conversationId: string;
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    const result = await db
      .delete(schema.conversationSharesTable)
      .where(
        and(
          eq(
            schema.conversationSharesTable.conversationId,
            params.conversationId,
          ),
          eq(
            schema.conversationSharesTable.organizationId,
            params.organizationId,
          ),
          eq(schema.conversationSharesTable.createdByUserId, params.userId),
        ),
      )
      .returning();

    return result.length > 0;
  }

  /**
   * Get a shared conversation with messages for viewing.
   * Only checks org-level access (not user ownership).
   */
  static async getSharedConversation(params: {
    shareId: string;
    organizationId: string;
  }): Promise<(Conversation & { sharedByUserId: string }) | null> {
    const share = await ConversationShareModel.findByShareId(params);
    if (!share) return null;

    const rows = await db
      .select({
        conversation: getTableColumns(schema.conversationsTable),
        message: getTableColumns(schema.messagesTable),
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
          systemPrompt: schema.agentsTable.systemPrompt,
          agentType: schema.agentsTable.agentType,
          llmApiKeyId: schema.agentsTable.llmApiKeyId,
        },
      })
      .from(schema.conversationsTable)
      .leftJoin(
        schema.agentsTable,
        eq(schema.conversationsTable.agentId, schema.agentsTable.id),
      )
      .leftJoin(
        schema.messagesTable,
        eq(schema.conversationsTable.id, schema.messagesTable.conversationId),
      )
      .where(eq(schema.conversationsTable.id, share.conversationId))
      .orderBy(schema.messagesTable.createdAt);

    if (rows.length === 0) return null;

    const firstRow = rows[0];
    const messages = [];

    for (const row of rows) {
      if (row.message?.content) {
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
      sharedByUserId: share.createdByUserId,
    };
  }
}

export default ConversationShareModel;
