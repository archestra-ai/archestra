import { and, asc, eq, type SQL } from "drizzle-orm";
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

  static async getAllInteractionsForChat(chatId: string, whereClauses?: SQL[]) {
    return db
      .select()
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.chatId, chatId),
          ...(whereClauses ?? []),
        ),
      )
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
   * Get all blocked tool calls for a chat
   *
   * Returns a list of interactions that have been marked as blocked by trusted data policies
   */
  static async getBlockedToolCalls(
    chatId: string,
  ): Promise<{ toolCallId: string; reason: string | null }[]> {
    const interactions = await InteractionModel.getAllInteractionsForChat(
      chatId,
      [eq(schema.interactionsTable.blocked, true)],
    );

    const data: { toolCallId: string; reason: string | null }[] = [];

    for (const interaction of interactions) {
      if (interaction.content.role === "tool") {
        const toolCallId = interaction.content.tool_call_id;
        if (toolCallId) {
          data.push({ toolCallId, reason: interaction.reason });
        }
      }
    }

    return data;
  }
}

export default InteractionModel;
