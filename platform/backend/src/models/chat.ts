import { desc, eq } from "drizzle-orm";
import type { z } from "zod";
import db, { schema } from "@/database";
import type { ChatWithInteractions, InsertChatSchema } from "@/types";

class ChatModel {
  static async create(data: z.infer<typeof InsertChatSchema>) {
    const [chat] = await db.insert(schema.chatsTable).values(data).returning();
    return chat;
  }

  static async findAll(): Promise<ChatWithInteractions[]> {
    const chats = await db
      .select()
      .from(schema.chatsTable)
      .leftJoin(
        schema.interactionsTable,
        eq(schema.chatsTable.id, schema.interactionsTable.chatId),
      )
      .orderBy(desc(schema.chatsTable.createdAt));

    // Group interactions by chat
    const chatMap = new Map<string, ChatWithInteractions>();
    for (const row of chats) {
      if (!row.chats) continue;

      if (!chatMap.has(row.chats.id)) {
        chatMap.set(row.chats.id, {
          ...row.chats,
          interactions: [],
        });
      }

      if (row.interactions) {
        chatMap.get(row.chats.id)?.interactions.push(row.interactions);
      }
    }

    // Sort interactions by createdAt for each chat
    const result = Array.from(chatMap.values());
    for (const chat of result) {
      chat.interactions.sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
    }

    return result;
  }

  static async findById(id: string): Promise<ChatWithInteractions | null> {
    const rows = await db
      .select()
      .from(schema.chatsTable)
      .leftJoin(
        schema.interactionsTable,
        eq(schema.chatsTable.id, schema.interactionsTable.chatId),
      )
      .where(eq(schema.chatsTable.id, id));

    if (rows.length === 0) {
      return null;
    }

    const chat = rows[0].chats;
    const interactions = rows
      .filter((row) => row.interactions !== null)
      .map((row) => row.interactions)
      .filter((interaction) => interaction !== null);

    // Sort interactions by createdAt
    interactions.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    return {
      ...chat,
      interactions,
    };
  }
}

export default ChatModel;
