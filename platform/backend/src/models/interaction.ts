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
}

export default InteractionModel;
