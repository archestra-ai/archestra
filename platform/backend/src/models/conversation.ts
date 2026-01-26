import {
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
} from "@shared";
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
  UpdateConversation,
} from "@/types";
import ConversationEnabledToolModel from "./conversation-enabled-tool";
import ToolModel from "./tool";

class ConversationModel {
  static async create(data: InsertConversation): Promise<Conversation> {
    const [conversation] = await db
      .insert(schema.conversationsTable)
      .values(data)
      .returning();

    // Disable Archestra tools by default for new conversations (except todo_write and artifact_write)
    // Get all tools assigned to the agent (profile tools)
    const agentTools = await ToolModel.getToolsByAgent(data.agentId);

    // Get agent delegation tools
    const delegationTools = await ToolModel.getDelegationToolsByAgent(
      data.agentId,
    );
    const delegationToolIds = delegationTools.map((d) => d.tool);

    // Combine profile tools and delegation tools
    const allTools = [...agentTools, ...delegationToolIds];

    // Filter out Archestra tools (those starting with "archestra__"), but keep todo_write and artifact_write enabled
    // Agent delegation tools (agent__*) should be enabled by default
    const nonArchestraToolIds = allTools
      .filter(
        (tool) =>
          !tool.name.startsWith("archestra__") ||
          tool.name === TOOL_TODO_WRITE_FULL_NAME ||
          tool.name === TOOL_ARTIFACT_WRITE_FULL_NAME,
      )
      .map((tool) => tool.id);

    // Set enabled tools to non-Archestra tools plus todo_write and artifact_write
    // This creates a custom tool selection with most Archestra tools disabled
    await ConversationEnabledToolModel.setEnabledTools(
      conversation.id,
      nonArchestraToolIds,
    );

    const conversationWithAgent = (await ConversationModel.findById({
      id: conversation.id,
      userId: data.userId,
      organizationId: data.organizationId,
    })) as Conversation;

    return conversationWithAgent;
  }

  /**
   * Escape special characters in LIKE patterns.
   * % and _ have special meaning in SQL LIKE patterns and need to be escaped.
   */
  private static escapeLikePattern(value: string): string {
    return value.replace(/[%_\\]/g, "\\$&");
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
      const escapedSearch = ConversationModel.escapeLikePattern(trimmedSearch);
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
      const escapedSearch = ConversationModel.escapeLikePattern(trimmedSearch);
      const searchPattern = `%${escapedSearch}%`;

      // Use a lateral join to limit messages per conversation for preview
      // This prevents loading hundreds of messages for conversations with long histories
      const rows = await db
        .select({
          conversation: getTableColumns(schema.conversationsTable),
          message: getTableColumns(schema.messagesTable),
          agent: {
            id: schema.agentsTable.id,
            name: schema.agentsTable.name,
            systemPrompt: schema.agentsTable.systemPrompt,
            userPrompt: schema.agentsTable.userPrompt,
            agentType: schema.agentsTable.agentType,
          },
        })
        .from(schema.conversationsTable)
        .innerJoin(
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
        .where(and(...conditions))
        .orderBy(
          desc(schema.conversationsTable.updatedAt),
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
            ...row.conversation,
            agent: row.agent,
            messages: [],
          });
        }

        const conversation = conversationMap.get(conversationId);
        if (conversation && row?.message?.content) {
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
          agent: {
            id: schema.agentsTable.id,
            name: schema.agentsTable.name,
            systemPrompt: schema.agentsTable.systemPrompt,
            userPrompt: schema.agentsTable.userPrompt,
            agentType: schema.agentsTable.agentType,
          },
        })
        .from(schema.conversationsTable)
        .innerJoin(
          schema.agentsTable,
          eq(schema.conversationsTable.agentId, schema.agentsTable.id),
        )
        .where(and(...conditions))
        .orderBy(desc(schema.conversationsTable.updatedAt));

      return rows.map((row) => ({
        ...row.conversation,
        agent: row.agent,
        messages: [], // Messages fetched separately via findById
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
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
          systemPrompt: schema.agentsTable.systemPrompt,
          userPrompt: schema.agentsTable.userPrompt,
          agentType: schema.agentsTable.agentType,
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
