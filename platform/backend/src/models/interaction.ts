import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "../database";
import type { InteractionContent } from "../types";

class InteractionModel {
  static async create(data: {
    chatId: string;
    content: InteractionContent;
    tainted?: boolean;
    taintReason?: string;
  }) {
    const [interaction] = await db
      .insert(schema.interactionsTable)
      .values({
        chatId: data.chatId,
        content: data.content,
        tainted: data.tainted ?? false,
        taintReason: data.taintReason,
      })
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
   * Check if context is tainted by querying for tainted interactions
   */
  static async checkIfChatIsTainted(chatId: string) {
    const taintedInteractions = await db
      .select()
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.chatId, chatId),
          eq(schema.interactionsTable.tainted, true),
        ),
      );
    return taintedInteractions.length > 0;
  }
}

export default InteractionModel;
