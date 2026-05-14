import type { PaginationQuery } from "@shared";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  Conversation,
  InsertConversation,
  UpdateConversation,
} from "@/types";
import { escapeLikePattern } from "@/utils/sql-search";
import ConversationChatErrorModel from "./conversation-chat-error";
import ConversationShareModel from "./conversation-share";

class ConversationModel {
  static async create(data: InsertConversation): Promise<Conversation> {
    const [conversation] = await db
      .insert(schema.conversationsTable)
      .values(data)
      .returning();

    // All tools assigned to the agent are enabled by default.
    // Users can customize enabled tools per-conversation after creation.

    const conversationWithAgent = (await ConversationModel.findById({
      id: conversation.id,
      userId: data.userId,
      organizationId: data.organizationId,
    })) as Conversation;

    return conversationWithAgent;
  }

  /**
   * Maximum number of messages to load per conversation for preview snippets.
   * Prevents memory issues with conversations that have hundreds of messages.
   */
  private static readonly MESSAGES_PER_CONVERSATION_LIMIT = 10;

  static async findAll(
    userId: string,
    organizationId: string,
    searchQuery?: string,
  ): Promise<Conversation[]> {
    const result = await ConversationModel.findAllPaginated({
      userId,
      organizationId,
      pagination: { limit: 100, offset: 0 },
      searchQuery,
      includePreviewMessages: !!searchQuery?.trim(),
    });

    return result.data;
  }

  /**
   * Get paginated conversations for a user.
   * Messages are excluded by default and fetched only for preview snippets.
   *
   * Note: Title search uses the conversations_title_trgm_idx index (created in 0116).
   * Message content search uses the messages_content_trgm_idx index (created in 0117).
   */
  static async findAllPaginated(params: {
    userId: string;
    organizationId: string;
    pagination: PaginationQuery;
    searchQuery?: string;
    includePreviewMessages?: boolean;
    pinned?: boolean;
  }): Promise<PaginatedResult<Conversation>> {
    const {
      userId,
      organizationId,
      pagination,
      searchQuery,
      includePreviewMessages = false,
      pinned,
    } = params;
    const trimmedSearch = searchQuery?.trim();
    const searchPattern = trimmedSearch
      ? `%${escapeLikePattern(trimmedSearch)}%`
      : undefined;

    const conditions: SQL[] = [
      eq(schema.conversationsTable.userId, userId),
      eq(schema.conversationsTable.organizationId, organizationId),
    ];

    if (pinned === true) {
      conditions.push(isNotNull(schema.conversationsTable.pinnedAt));
    } else if (pinned === false) {
      conditions.push(isNull(schema.conversationsTable.pinnedAt));
    }

    if (searchPattern) {
      const searchConditions = or(
        and(
          isNotNull(schema.conversationsTable.title),
          ilike(schema.conversationsTable.title, searchPattern),
        ),
        sql`EXISTS (
          SELECT 1 FROM ${schema.messagesTable}
          WHERE ${schema.messagesTable.conversationId} = ${schema.conversationsTable.id}
          AND ${schema.messagesTable.content}::text ILIKE ${searchPattern}
        )`,
      );

      if (searchConditions) {
        conditions.push(searchConditions);
      }
    }

    const whereClause = and(...conditions);
    const orderByClause =
      pinned === undefined
        ? [
            sql`CASE WHEN ${schema.conversationsTable.pinnedAt} IS NOT NULL THEN 0 ELSE 1 END`,
            desc(schema.conversationsTable.updatedAt),
          ]
        : [desc(schema.conversationsTable.updatedAt)];

    const [rows, totalResult] = await Promise.all([
      db
        .select({
          conversation: getTableColumns(schema.conversationsTable),
          share: {
            id: schema.conversationSharesTable.id,
            visibility: schema.conversationSharesTable.visibility,
          },
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
          schema.conversationSharesTable,
          eq(
            schema.conversationsTable.id,
            schema.conversationSharesTable.conversationId,
          ),
        )
        .where(whereClause)
        .orderBy(...orderByClause)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ count: count() })
        .from(schema.conversationsTable)
        .where(whereClause),
    ]);

    const conversations: Conversation[] = rows.map((row) => ({
      ...row.conversation,
      agent: row.agent,
      share: row.share?.id ? row.share : null,
      messages: [],
      chatErrors: [],
    }));

    if (includePreviewMessages && conversations.length > 0) {
      const messagesByConversationId =
        await ConversationModel.findPreviewMessagesByConversationIds({
          conversationIds: conversations.map((conversation) => conversation.id),
          searchPattern,
        });

      for (const conversation of conversations) {
        conversation.messages =
          messagesByConversationId.get(conversation.id) ?? [];
      }
    }

    return createPaginatedResult(
      conversations,
      totalResult[0]?.count ?? 0,
      pagination,
    );
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
        share: {
          id: schema.conversationSharesTable.id,
          visibility: schema.conversationSharesTable.visibility,
        },
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
      .leftJoin(
        schema.conversationSharesTable,
        eq(
          schema.conversationsTable.id,
          schema.conversationSharesTable.conversationId,
        ),
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
    const chatErrors = await ConversationChatErrorModel.findByConversation(id);
    const messages = [];

    for (const row of rows) {
      if (row.message?.content) {
        // Merge database UUID into message content (overrides AI SDK's temporary ID)
        messages.push(addMessagePersistenceMetadata(row.message));
      }
    }

    return {
      ...firstRow.conversation,
      agent: firstRow.agent,
      share: firstRow.share?.id ? firstRow.share : null,
      messages,
      chatErrors,
    };
  }

  static async findAccessibleById(params: {
    id: string;
    userId: string;
    organizationId: string;
  }): Promise<Conversation | null> {
    const ownedConversation = await ConversationModel.findById(params);

    if (ownedConversation) {
      return ownedConversation;
    }

    const accessibleShare =
      await ConversationShareModel.findAccessibleByConversationId({
        conversationId: params.id,
        organizationId: params.organizationId,
        userId: params.userId,
      });

    if (!accessibleShare) {
      return null;
    }

    // Shared conversations intentionally return another user's conversation
    // once share access has been validated for this org/user pair.
    return ConversationModel.findByIdInOrganization({
      id: params.id,
      organizationId: params.organizationId,
    });
  }

  static async findByIdInOrganization(params: {
    id: string;
    organizationId: string;
  }): Promise<Conversation | null> {
    const rows = await db
      .select({
        conversation: getTableColumns(schema.conversationsTable),
        message: getTableColumns(schema.messagesTable),
        share: {
          id: schema.conversationSharesTable.id,
          visibility: schema.conversationSharesTable.visibility,
        },
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
      .leftJoin(
        schema.conversationSharesTable,
        eq(
          schema.conversationsTable.id,
          schema.conversationSharesTable.conversationId,
        ),
      )
      .where(
        and(
          eq(schema.conversationsTable.id, params.id),
          eq(schema.conversationsTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(schema.messagesTable.createdAt);

    if (rows.length === 0) {
      return null;
    }

    const firstRow = rows[0];
    const chatErrors = await ConversationChatErrorModel.findByConversation(
      params.id,
    );
    const messages = [];

    for (const row of rows) {
      if (row.message?.content) {
        messages.push(addMessagePersistenceMetadata(row.message));
      }
    }

    return {
      ...firstRow.conversation,
      agent: firstRow.agent,
      share: firstRow.share?.id ? firstRow.share : null,
      messages,
      chatErrors,
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

  /**
   * Get the agentId for a conversation (without user context checks)
   * Used by internal services that need to look up conversation -> agent mapping
   */
  static async getAgentId(conversationId: string): Promise<string | null> {
    const result = await db
      .select({ agentId: schema.conversationsTable.agentId })
      .from(schema.conversationsTable)
      .where(eq(schema.conversationsTable.id, conversationId))
      .limit(1);

    return result[0]?.agentId ?? null;
  }

  /**
   * Get the agentId for a conversation scoped to a specific user and organization.
   * Returns null when the conversation does not belong to the provided user/org.
   */
  static async getAgentIdForUser(
    conversationId: string,
    userId: string,
    organizationId: string,
  ): Promise<string | null> {
    const result = await db
      .select({ agentId: schema.conversationsTable.agentId })
      .from(schema.conversationsTable)
      .where(
        and(
          eq(schema.conversationsTable.id, conversationId),
          eq(schema.conversationsTable.userId, userId),
          eq(schema.conversationsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    return result[0]?.agentId ?? null;
  }

  private static async findPreviewMessagesByConversationIds({
    conversationIds,
    searchPattern,
  }: {
    conversationIds: string[];
    searchPattern?: string;
  }): Promise<Map<string, Conversation["messages"]>> {
    if (conversationIds.length === 0) {
      return new Map();
    }

    const firstMessagesCondition = sql`${schema.messagesTable.id} IN (
      SELECT m.id FROM messages m
      WHERE m.conversation_id = ${schema.messagesTable.conversationId}
      ORDER BY m.created_at
      LIMIT ${ConversationModel.MESSAGES_PER_CONVERSATION_LIMIT}
    )`;

    const previewCondition = searchPattern
      ? or(
          sql`${schema.messagesTable.content}::text ILIKE ${searchPattern}`,
          firstMessagesCondition,
        )
      : firstMessagesCondition;

    const rows = await db
      .select({
        id: schema.messagesTable.id,
        conversationId: schema.messagesTable.conversationId,
        content: schema.messagesTable.content,
      })
      .from(schema.messagesTable)
      .where(
        and(
          inArray(schema.messagesTable.conversationId, conversationIds),
          previewCondition,
        ),
      )
      .orderBy(
        schema.messagesTable.conversationId,
        schema.messagesTable.createdAt,
      );

    const messagesByConversationId = new Map<
      string,
      Conversation["messages"]
    >();

    for (const row of rows) {
      const messages = messagesByConversationId.get(row.conversationId) ?? [];
      if (
        messages.length >= ConversationModel.MESSAGES_PER_CONVERSATION_LIMIT
      ) {
        continue;
      }

      messages.push({
        ...row.content,
        id: row.id,
      });
      messagesByConversationId.set(row.conversationId, messages);
    }

    return messagesByConversationId;
  }
}

export default ConversationModel;

function addMessagePersistenceMetadata(message: {
  id: string;
  content: unknown;
  createdAt: Date;
}) {
  const content =
    typeof message.content === "object" && message.content !== null
      ? message.content
      : {};
  const metadata =
    "metadata" in content &&
    typeof content.metadata === "object" &&
    content.metadata !== null
      ? content.metadata
      : {};

  return {
    ...content,
    id: message.id,
    metadata: {
      ...metadata,
      createdAt: message.createdAt.toISOString(),
    },
  };
}
