import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ChatSettings,
  InsertChatSettings,
  UpdateChatSettings,
} from "@/types";

class ChatSettingsModel {
  static async create(data: InsertChatSettings): Promise<ChatSettings> {
    const [settings] = await db
      .insert(schema.chatSettingsTable)
      .values(data)
      .returning();

    return settings;
  }

  static async findByOrganizationId(
    organizationId: string,
  ): Promise<ChatSettings | null> {
    const [settings] = await db
      .select()
      .from(schema.chatSettingsTable)
      .where(eq(schema.chatSettingsTable.organizationId, organizationId));

    return settings ? (settings as ChatSettings) : null;
  }

  static async getOrCreate(organizationId: string): Promise<ChatSettings> {
    const existing =
      await ChatSettingsModel.findByOrganizationId(organizationId);

    if (existing) {
      return existing;
    }

    return await ChatSettingsModel.create({ organizationId });
  }

  static async update(
    organizationId: string,
    data: UpdateChatSettings,
  ): Promise<ChatSettings | null> {
    const [updated] = await db
      .update(schema.chatSettingsTable)
      .set(data)
      .where(eq(schema.chatSettingsTable.organizationId, organizationId))
      .returning();

    return updated ? (updated as ChatSettings) : null;
  }
}

export default ChatSettingsModel;
