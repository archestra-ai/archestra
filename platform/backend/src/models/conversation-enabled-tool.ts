import { eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

class ConversationEnabledToolModel {
  /**
   * Get enabled tool IDs for a conversation
   * Returns empty array if no custom selection (meaning all tools enabled)
   */
  static async findByConversation(conversationId: string): Promise<string[]> {
    logger.debug(
      { conversationId },
      "ConversationEnabledToolModel.findByConversation: fetching enabled tools",
    );

    const enabledTools = await db
      .select({ toolId: schema.conversationEnabledToolsTable.toolId })
      .from(schema.conversationEnabledToolsTable)
      .where(
        eq(schema.conversationEnabledToolsTable.conversationId, conversationId),
      );

    const toolIds = enabledTools.map((t) => t.toolId);

    logger.debug(
      { conversationId, count: toolIds.length },
      "ConversationEnabledToolModel.findByConversation: completed",
    );

    return toolIds;
  }

  /**
   * Check if conversation has custom tool selection
   * Returns the value of the has_custom_tool_selection field
   */
  static async hasCustomSelection(conversationId: string): Promise<boolean> {
    logger.debug(
      { conversationId },
      "ConversationEnabledToolModel.hasCustomSelection: checking",
    );

    const result = await db
      .select({
        hasCustomToolSelection:
          schema.conversationsTable.hasCustomToolSelection,
      })
      .from(schema.conversationsTable)
      .where(eq(schema.conversationsTable.id, conversationId))
      .limit(1);

    const hasCustom = result[0]?.hasCustomToolSelection ?? false;

    logger.debug(
      { conversationId, hasCustomSelection: hasCustom },
      "ConversationEnabledToolModel.hasCustomSelection: completed",
    );

    return hasCustom;
  }

  /**
   * Set enabled tools for a conversation (replaces all existing)
   * Pass empty array to disable all tools (custom selection with zero tools)
   * Invalid tool IDs (not in tools table) are silently filtered out.
   */
  static async setEnabledTools(
    conversationId: string,
    toolIds: string[],
  ): Promise<void> {
    logger.debug(
      { conversationId, toolCount: toolIds.length },
      "ConversationEnabledToolModel.setEnabledTools: setting enabled tools",
    );

    // Filter to only valid tool IDs that exist in the tools table
    let validToolIds: string[] = [];
    if (toolIds.length > 0) {
      const existingTools = await db
        .select({ id: schema.toolsTable.id })
        .from(schema.toolsTable)
        .where(inArray(schema.toolsTable.id, toolIds));

      validToolIds = existingTools.map((t) => t.id);

      if (validToolIds.length < toolIds.length) {
        const invalidIds = toolIds.filter((id) => !validToolIds.includes(id));
        logger.warn(
          { conversationId, invalidIds },
          "ConversationEnabledToolModel.setEnabledTools: filtered out invalid tool IDs",
        );
      }
    }

    await db.transaction(async (tx) => {
      // Update the conversation to mark it as having custom tool selection
      await tx
        .update(schema.conversationsTable)
        .set({ hasCustomToolSelection: true })
        .where(eq(schema.conversationsTable.id, conversationId));

      // Delete all existing enabled tool entries
      await tx
        .delete(schema.conversationEnabledToolsTable)
        .where(
          eq(
            schema.conversationEnabledToolsTable.conversationId,
            conversationId,
          ),
        );

      // Insert new enabled tool entries (only if there are valid tools to insert)
      if (validToolIds.length > 0) {
        await tx.insert(schema.conversationEnabledToolsTable).values(
          validToolIds.map((toolId) => ({
            conversationId,
            toolId,
          })),
        );
      }
    });

    logger.debug(
      { conversationId, enabledCount: validToolIds.length },
      "ConversationEnabledToolModel.setEnabledTools: completed",
    );
  }

  /**
   * Clear custom selection (revert to all tools enabled)
   */
  static async clearCustomSelection(conversationId: string): Promise<void> {
    logger.debug(
      { conversationId },
      "ConversationEnabledToolModel.clearCustomSelection: clearing",
    );

    await db.transaction(async (tx) => {
      // Update the conversation to mark it as not having custom tool selection
      await tx
        .update(schema.conversationsTable)
        .set({ hasCustomToolSelection: false })
        .where(eq(schema.conversationsTable.id, conversationId));

      // Delete all enabled tool entries
      await tx
        .delete(schema.conversationEnabledToolsTable)
        .where(
          eq(
            schema.conversationEnabledToolsTable.conversationId,
            conversationId,
          ),
        );
    });

    logger.debug(
      { conversationId },
      "ConversationEnabledToolModel.clearCustomSelection: completed",
    );
  }

  /**
   * Get enabled tools for multiple conversations in one query (batch)
   * Useful to avoid N+1 queries
   */
  static async findByConversations(
    conversationIds: string[],
  ): Promise<Map<string, string[]>> {
    logger.debug(
      { count: conversationIds.length },
      "ConversationEnabledToolModel.findByConversations: fetching",
    );

    if (conversationIds.length === 0) {
      return new Map();
    }

    const enabledTools = await db
      .select({
        conversationId: schema.conversationEnabledToolsTable.conversationId,
        toolId: schema.conversationEnabledToolsTable.toolId,
      })
      .from(schema.conversationEnabledToolsTable)
      .where(
        inArray(
          schema.conversationEnabledToolsTable.conversationId,
          conversationIds,
        ),
      );

    const toolsMap = new Map<string, string[]>();

    // Initialize all conversation IDs with empty arrays
    for (const conversationId of conversationIds) {
      toolsMap.set(conversationId, []);
    }

    // Populate the map
    for (const { conversationId, toolId } of enabledTools) {
      const tools = toolsMap.get(conversationId) || [];
      tools.push(toolId);
      toolsMap.set(conversationId, tools);
    }

    logger.debug(
      {
        conversationCount: conversationIds.length,
        entryCount: enabledTools.length,
      },
      "ConversationEnabledToolModel.findByConversations: completed",
    );

    return toolsMap;
  }
}

export default ConversationEnabledToolModel;
