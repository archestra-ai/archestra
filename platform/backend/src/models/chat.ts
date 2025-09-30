import { desc, eq } from "drizzle-orm";
import db, {
  type ChatWithInteractions,
  chatsTable,
  interactionsTable,
} from "../database";

class ChatModel {
  static async create() {
    const [chat] = await db.insert(chatsTable).values({}).returning();
    return chat;
  }

  static async findAll(): Promise<ChatWithInteractions[]> {
    const chats = await db
      .select()
      .from(chatsTable)
      .leftJoin(interactionsTable, eq(chatsTable.id, interactionsTable.chatId))
      .orderBy(desc(chatsTable.createdAt));

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

    return Array.from(chatMap.values());
  }

  static async findById(id: string): Promise<ChatWithInteractions | null> {
    const rows = await db
      .select()
      .from(chatsTable)
      .leftJoin(interactionsTable, eq(chatsTable.id, interactionsTable.chatId))
      .where(eq(chatsTable.id, id));

    if (rows.length === 0) {
      return null;
    }

    const chat = rows[0].chats;
    const interactions = rows
      .filter((row) => row.interactions !== null)
      .map((row) => row.interactions!);

    return {
      ...chat,
      interactions,
    };
  }
}

export default ChatModel;
