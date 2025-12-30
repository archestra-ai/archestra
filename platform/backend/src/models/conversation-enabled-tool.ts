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
   * Returns true if there are entries in the junction table
   */
  static async hasCustomSelection(conversationId: string): Promise<boolean> {
    logger.debug(
      { conversationId },
      "ConversationEnabledToolModel.hasCustomSelection: checking",
    );

    const result = await db
      .select({ toolId: schema.conversationEnabledToolsTable.toolId })
      .from(schema.conversationEnabledToolsTable)
      .where(
        eq(schema.conversationEnabledToolsTable.conversationId, conversationId),
      )
      .limit(1);

    const hasCustom = result.length > 0;

    logger.debug(
      { conversationId, hasCustomSelection: hasCustom },
      "ConversationEnabledToolModel.hasCustomSelection: completed",
    );

    return hasCustom;
  }

  /**
   * Set enabled tools for a conversation (replaces all existing)
   * Pass empty array to clear custom selection (all tools enabled)
   */
  static async setEnabledTools(
    conversationId: string,
    toolIds: string[],
  ): Promise<void> {
    logger.debug(
      { conversationId, toolCount: toolIds.length },
      "ConversationEnabledToolModel.setEnabledTools: setting enabled tools",
    );

    await db.transaction(async (tx) => {
      // Delete all existing enabled tool entries
      await tx
        .delete(schema.conversationEnabledToolsTable)
        .where(
          eq(
            schema.conversationEnabledToolsTable.conversationId,
            conversationId,
          ),
        );

      // Insert new enabled tool entries (if any)
      if (toolIds.length > 0) {
        await tx.insert(schema.conversationEnabledToolsTable).values(
          toolIds.map((toolId) => ({
            conversationId,
            toolId,
          })),
        );
      }
    });

    logger.debug(
      { conversationId, enabledCount: toolIds.length },
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

    await db
      .delete(schema.conversationEnabledToolsTable)
      .where(
        eq(schema.conversationEnabledToolsTable.conversationId, conversationId),
      );

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
