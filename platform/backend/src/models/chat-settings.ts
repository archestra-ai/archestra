import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

export type ChatProvider = "anthropic" | "openai";

export interface ChatSettings {
  id: string;
  organizationId: string;
  provider: ChatProvider;
  model: string | null;
  anthropicApiKeySecretId: string | null;
  openaiApiKeySecretId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateChatSettingsInput {
  organizationId: string;
  provider?: ChatProvider;
  model?: string | null;
  anthropicApiKeySecretId?: string | null;
  openaiApiKeySecretId?: string | null;
}

export interface UpdateChatSettingsInput {
  provider?: ChatProvider;
  model?: string | null;
  anthropicApiKeySecretId?: string | null;
  openaiApiKeySecretId?: string | null;
}

/**
 * Model for managing chat settings
 * Provides CRUD operations for organization-specific chat configuration
 */
class ChatSettingsModel {
  /**
   * Create chat settings for an organization
   */
  static async create(input: CreateChatSettingsInput): Promise<ChatSettings> {
    const [settings] = await db
      .insert(schema.chatSettingsTable)
      .values({
        organizationId: input.organizationId,
        provider: input.provider || "anthropic",
        anthropicApiKeySecretId: input.anthropicApiKeySecretId || null,
        openaiApiKeySecretId: input.openaiApiKeySecretId || null,
      })
      .returning();

    return settings as ChatSettings;
  }

  /**
   * Find chat settings by organization ID
   */
  static async findByOrganizationId(
    organizationId: string,
  ): Promise<ChatSettings | null> {
    const [settings] = await db
      .select()
      .from(schema.chatSettingsTable)
      .where(eq(schema.chatSettingsTable.organizationId, organizationId));

    return settings ? (settings as ChatSettings) : null;
  }

  /**
   * Get or create chat settings for an organization
   */
  static async getOrCreate(organizationId: string): Promise<ChatSettings> {
    const existing =
      await ChatSettingsModel.findByOrganizationId(organizationId);

    if (existing) {
      return existing;
    }

    return await ChatSettingsModel.create({ organizationId });
  }

  /**
   * Update chat settings
   */
  static async update(
    organizationId: string,
    input: UpdateChatSettingsInput,
  ): Promise<ChatSettings | null> {
    const updateData: Partial<CreateChatSettingsInput> = {};

    if (input.provider !== undefined) {
      updateData.provider = input.provider;
    }
    if (input.model !== undefined) {
      updateData.model = input.model;
    }
    if (input.anthropicApiKeySecretId !== undefined) {
      updateData.anthropicApiKeySecretId = input.anthropicApiKeySecretId;
    }
    if (input.openaiApiKeySecretId !== undefined) {
      updateData.openaiApiKeySecretId = input.openaiApiKeySecretId;
    }

    const [updated] = await db
      .update(schema.chatSettingsTable)
      .set(updateData)
      .where(eq(schema.chatSettingsTable.organizationId, organizationId))
      .returning();

    return updated ? (updated as ChatSettings) : null;
  }

  /**
   * Delete chat settings
   */
  static async delete(organizationId: string): Promise<boolean> {
    const result = await db
      .delete(schema.chatSettingsTable)
      .where(eq(schema.chatSettingsTable.organizationId, organizationId));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default ChatSettingsModel;
