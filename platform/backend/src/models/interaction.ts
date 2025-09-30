import { and, asc, eq } from "drizzle-orm";
import db, { interactionsTable, type MessageContent } from "../database";

class InteractionModel {
  static async create(data: {
    chatId: string;
    content: MessageContent;
    tainted?: boolean;
    taintReason?: string;
  }) {
    const [interaction] = await db
      .insert(interactionsTable)
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
      .from(interactionsTable)
      .where(eq(interactionsTable.chatId, chatId))
      .orderBy(asc(interactionsTable.createdAt));
  }

  static async findTaintedByChatId(chatId: string) {
    return await db
      .select()
      .from(interactionsTable)
      .where(
        and(
          eq(interactionsTable.chatId, chatId),
          eq(interactionsTable.tainted, true),
        ),
      )
      .orderBy(asc(interactionsTable.createdAt));
  }
}

export default InteractionModel;
