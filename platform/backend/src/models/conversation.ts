import { hasPersistableAssistantContent } from "@archestra/shared";
import {
  and,
  desc,
  eq,
  getTableColumns,
  ilike,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  Conversation,
  InsertConversation,
  ToolExposureMode,
  UpdateConversation,
} from "@/types";
import { escapeLikePattern } from "@/utils/sql-search";
import ConversationChatErrorModel from "./conversation-chat-error";
import ConversationCompactionModel from "./conversation-compaction";
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
   * Maximum number of conversations to return in search results.
   * Prevents unbounded result sets for common search terms.
   */
  private static readonly SEARCH_RESULT_LIMIT = 50;

  /**
   * Maximum number of messages to load per conversation for preview snippets.
   * Prevents memory issues with conversations that have hundreds of messages.
   */
  private static readonly MESSAGES_PER_CONVERSATION_LIMIT = 10;

  /**
   * Get all conversations for a user without messages.
   * Messages are fetched separately via findById when a conversation is opened.
   * This significantly improves performance for the conversations list.
   *
   * When searching, a limited number of messages ARE included to enable preview snippets.
   * Search results are also limited to prevent unbounded result sets.
   *
   * Note: Title search uses the conversations_title_trgm_idx index (created in 0116).
   * Message content search uses the messages_content_trgm_idx index (created in 0117).
   *
   * @param searchQuery - Optional search string to filter conversations by title or message content
   */
  static async findAll(
    userId: string,
    organizationId: string,
    searchQuery?: string,
  ): Promise<Conversation[]> {
    const trimmedSearch = searchQuery?.trim();

    // Build WHERE conditions
    const conditions = [
      eq(schema.conversationsTable.userId, userId),
      eq(schema.conversationsTable.organizationId, organizationId),
    ];

    // Add search filter if provided
    if (trimmedSearch) {
      // Escape LIKE special characters (%, _, \) to prevent unexpected pattern matching
      const escapedSearch = escapeLikePattern(trimmedSearch);
      const searchPattern = `%${escapedSearch}%`;

      // 1. Conversation title (text column) - uses conversations_title_trgm_idx
      // 2. Message content (JSONB cast to text) - uses messages_content_trgm_idx
      const searchConditions = or(
        // Search in title (handles null titles gracefully)
        and(
          isNotNull(schema.conversationsTable.title),
          ilike(schema.conversationsTable.title, searchPattern),
        ),
        // Search through messages JSONB content
        // Uses EXISTS for early termination
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

    // Include messages only during search for preview snippets
    if (trimmedSearch) {
      // Escape search pattern for message subquery
      const escapedSearch = escapeLikePattern(trimmedSearch);
      const searchPattern = `%${escapedSearch}%`;

      // Use a lateral join to limit messages per conversation for preview
      // This prevents loading hundreds of messages for conversations with long histories
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
            toolExposureMode: schema.agentsTable.toolExposureMode,
            llmApiKeyId: schema.agentsTable.llmApiKeyId,
            deletedAt: schema.agentsTable.deletedAt,
          },
        })
        .from(schema.conversationsTable)
        .leftJoin(
          schema.agentsTable,
          eq(schema.conversationsTable.agentId, schema.agentsTable.id),
        )
        .leftJoin(
          schema.messagesTable,
          and(
            eq(
              schema.conversationsTable.id,
              schema.messagesTable.conversationId,
            ),
            // Only include messages that match the search pattern (for relevance)
            // or the first few messages (for context)
            sql`(
              ${schema.messagesTable.content}::text ILIKE ${searchPattern}
              OR ${schema.messagesTable.id} IN (
                SELECT m.id FROM ${schema.messagesTable} m
                WHERE m.conversation_id = ${schema.conversationsTable.id}
                ORDER BY m.created_at
                LIMIT ${ConversationModel.MESSAGES_PER_CONVERSATION_LIMIT}
              )
            )`,
          ),
        )
        .leftJoin(
          schema.conversationSharesTable,
          eq(
            schema.conversationsTable.id,
            schema.conversationSharesTable.conversationId,
          ),
        )
        .where(and(...conditions))
        .orderBy(
          desc(schema.conversationsTable.lastMessageAt),
          schema.messagesTable.createdAt,
        )
        .limit(
          ConversationModel.SEARCH_RESULT_LIMIT *
            ConversationModel.MESSAGES_PER_CONVERSATION_LIMIT,
        );

      // Group messages by conversation
      const conversationMap = new Map<string, Conversation>();

      for (const row of rows) {
        const conversationId = row.conversation.id;

        if (!conversationMap.has(conversationId)) {
          // Stop adding new conversations if we've reached the limit
          if (conversationMap.size >= ConversationModel.SEARCH_RESULT_LIMIT) {
            continue;
          }
          conversationMap.set(conversationId, {
            ...withVisibleAgent(row.conversation, row.agent),
            share: row.share?.id ? row.share : null,
            messages: [],
            chatErrors: [],
            compactions: [],
          });
        }

        const conversation = conversationMap.get(conversationId);
        if (
          conversation &&
          row?.message?.content &&
          shouldReturnPersistedMessageRow(row.message)
        ) {
          // Limit messages per conversation for preview
          if (
            conversation.messages.length <
            ConversationModel.MESSAGES_PER_CONVERSATION_LIMIT
          ) {
            // Merge database UUID into message content
            conversation.messages.push({
              ...row.message.content,
              id: row.message.id,
            });
          }
        }
      }

      return Array.from(conversationMap.values());
    } else {
      // Non-search case: exclude messages for performance
      const rows = await db
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
            toolExposureMode: schema.agentsTable.toolExposureMode,
            llmApiKeyId: schema.agentsTable.llmApiKeyId,
            deletedAt: schema.agentsTable.deletedAt,
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
        .where(and(...conditions))
        .orderBy(desc(schema.conversationsTable.lastMessageAt));

      return rows.map((row) => ({
        ...withVisibleAgent(row.conversation, row.agent),
        share: row.share?.id ? row.share : null,
        messages: [], // Messages fetched separately via findById
        chatErrors: [],
        compactions: [],
      }));
    }
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
          toolExposureMode: schema.agentsTable.toolExposureMode,
          llmApiKeyId: schema.agentsTable.llmApiKeyId,
          deletedAt: schema.agentsTable.deletedAt,
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
    const [chatErrors, compactions] = await Promise.all([
      ConversationChatErrorModel.findByConversation(id),
      ConversationCompactionModel.findByConversation(id),
    ]);
    const messages = [];

    for (const row of rows) {
      if (
        row.message?.content &&
        shouldReturnPersistedMessageRow(row.message)
      ) {
        // Merge database UUID into message content (overrides AI SDK's temporary ID)
        messages.push(addMessagePersistenceMetadata(row.message));
      }
    }

    return {
      ...withVisibleAgent(firstRow.conversation, firstRow.agent),
      share: firstRow.share?.id ? firstRow.share : null,
      messages,
      chatErrors,
      compactions,
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
          toolExposureMode: schema.agentsTable.toolExposureMode,
          llmApiKeyId: schema.agentsTable.llmApiKeyId,
          deletedAt: schema.agentsTable.deletedAt,
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
    const [chatErrors, compactions] = await Promise.all([
      ConversationChatErrorModel.findByConversation(params.id),
      ConversationCompactionModel.findByConversation(params.id),
    ]);
    const messages = [];

    for (const row of rows) {
      if (
        row.message?.content &&
        shouldReturnPersistedMessageRow(row.message)
      ) {
        messages.push(addMessagePersistenceMetadata(row.message));
      }
    }

    return {
      ...withVisibleAgent(firstRow.conversation, firstRow.agent),
      share: firstRow.share?.id ? firstRow.share : null,
      messages,
      chatErrors,
      compactions,
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

  /**
   * Toggle per-conversation hook debug mode. Kept off the generic
   * {@link UpdateConversation} path on purpose: that schema backs the
   * member-accessible update route, whereas this flag is admin-gated at the
   * route layer. Scoped by user + org. Returns the new value, or null if no
   * conversation matched.
   */
  static async setHooksDebugEnabled(params: {
    id: string;
    userId: string;
    organizationId: string;
    enabled: boolean;
  }): Promise<boolean | null> {
    const [updated] = await db
      .update(schema.conversationsTable)
      .set({ hooksDebugEnabled: params.enabled })
      .where(
        and(
          eq(schema.conversationsTable.id, params.id),
          eq(schema.conversationsTable.userId, params.userId),
          eq(schema.conversationsTable.organizationId, params.organizationId),
        ),
      )
      .returning({
        hooksDebugEnabled: schema.conversationsTable.hooksDebugEnabled,
      });
    return updated ? updated.hooksDebugEnabled : null;
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
}

export default ConversationModel;

// Read-side guard for assistant rows that were persisted before the strict
// persist normalization (or by an older client) and would otherwise reload as
// an empty bubble. The DB `role` column is authoritative — a `content: ""` row
// has no role inside its content. Read-only: bad rows are hidden, never deleted.
function shouldReturnPersistedMessageRow(message: {
  role: string;
  content: unknown;
}): boolean {
  if (message.role !== "assistant") {
    return true;
  }
  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }
  return hasPersistableAssistantContent(
    message.content as { parts?: ReadonlyArray<{ type: string }> },
  );
}

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

type JoinedConversationAgent = {
  id: string | null;
  name: string | null;
  systemPrompt: string | null;
  agentType: "profile" | "mcp_gateway" | "llm_proxy" | "agent" | null;
  toolExposureMode: ToolExposureMode | null;
  llmApiKeyId: string | null;
  deletedAt: Date | null;
} | null;

function withVisibleAgent(
  conversation: typeof schema.conversationsTable.$inferSelect,
  agent: JoinedConversationAgent,
): typeof schema.conversationsTable.$inferSelect & {
  agent: Conversation["agent"];
} {
  if (!agent?.id || agent.deletedAt !== null) {
    return {
      ...conversation,
      agentId: null,
      agent: null,
    };
  }

  return {
    ...conversation,
    agent: {
      id: agent.id,
      name: agent.name ?? "",
      systemPrompt: agent.systemPrompt,
      agentType: agent.agentType ?? "agent",
      toolExposureMode: agent.toolExposureMode ?? "full",
      llmApiKeyId: agent.llmApiKeyId,
    },
  };
}
