import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "../database";
import type { InsertInteraction } from "../types";

class InteractionModel {
  static async create(data: InsertInteraction) {
    const [interaction] = await db
      .insert(schema.interactionsTable)
      .values(data)
      .returning();

    return interaction;
  }

  static async findByChatId(chatId: string) {
    return await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.chatId, chatId))
      .orderBy(asc(schema.interactionsTable.createdAt));
  }

  /**
   * Check if context is trusted by querying for non-trusted interactions
   */
  static async checkIfChatIsTrusted(chatId: string) {
    const untrustedInteractions = await db
      .select()
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.chatId, chatId),
          eq(schema.interactionsTable.trusted, false),
        ),
      );
    return untrustedInteractions.length === 0;
  }

  /**
   * Get all blocked tool call IDs for a chat
   *
   * Returns a Set of tool_call_ids that have been marked as blocked
   * by trusted data policies
   */
  static async getBlockedToolCallIds(chatId: string): Promise<Set<string>> {
    const interactions = await InteractionModel.findByChatId(chatId);

    const blockedToolCallIds = new Set<string>();

    for (const interaction of interactions) {
      if (interaction.blocked && interaction.content.role === "tool") {
        const toolCallId = interaction.content.tool_call_id;
        if (toolCallId) {
          blockedToolCallIds.add(toolCallId);
        }
      }
    }

    return blockedToolCallIds;
  }
}

export default InteractionModel;
