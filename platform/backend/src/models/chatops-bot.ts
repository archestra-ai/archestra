import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ChatOpsProviderType } from "@/types";
import type { ChatOpsBot, UpdateChatOpsBot } from "@/types/chatops-bot";

/**
 * Model for messaging bots: Slack Apps (several per organization) and the
 * single org-level Microsoft Teams / Telegram bot.
 */
class ChatOpsBotModel {
  static async findById(id: string): Promise<ChatOpsBot | null> {
    const [bot] = await db
      .select()
      .from(schema.chatopsBotsTable)
      .where(eq(schema.chatopsBotsTable.id, id));
    return (bot as ChatOpsBot) ?? null;
  }

  static async findByIdAndOrganization(
    id: string,
    organizationId: string,
  ): Promise<ChatOpsBot | null> {
    const [bot] = await db
      .select()
      .from(schema.chatopsBotsTable)
      .where(
        and(
          eq(schema.chatopsBotsTable.id, id),
          eq(schema.chatopsBotsTable.organizationId, organizationId),
        ),
      );
    return (bot as ChatOpsBot) ?? null;
  }

  /** Every bot of an organization, oldest first (the first Slack App is app #1). */
  static async findByOrganization(
    organizationId: string,
  ): Promise<ChatOpsBot[]> {
    const bots = await db
      .select()
      .from(schema.chatopsBotsTable)
      .where(eq(schema.chatopsBotsTable.organizationId, organizationId))
      .orderBy(
        asc(schema.chatopsBotsTable.createdAt),
        asc(schema.chatopsBotsTable.id),
      );
    return bots as ChatOpsBot[];
  }

  static async findByProvider(params: {
    organizationId: string;
    provider: ChatOpsProviderType;
  }): Promise<ChatOpsBot[]> {
    const bots = await db
      .select()
      .from(schema.chatopsBotsTable)
      .where(
        and(
          eq(schema.chatopsBotsTable.organizationId, params.organizationId),
          eq(schema.chatopsBotsTable.provider, params.provider),
        ),
      )
      .orderBy(
        asc(schema.chatopsBotsTable.createdAt),
        asc(schema.chatopsBotsTable.id),
      );
    return bots as ChatOpsBot[];
  }

  /**
   * The provider's first bot: the only bot for Teams and Telegram, and Slack
   * App #1 for callers that predate multiple Slack Apps.
   */
  static async findDefault(params: {
    organizationId: string;
    provider: ChatOpsProviderType;
  }): Promise<ChatOpsBot | null> {
    const [bot] = await ChatOpsBotModel.findByProvider(params);
    return bot ?? null;
  }

  static async create(input: {
    /** Pre-chosen id, for callers that need it before the row exists. */
    id?: string;
    organizationId: string;
    provider: ChatOpsProviderType;
    name: string;
    secretId?: string | null;
  }): Promise<ChatOpsBot> {
    const [bot] = await db
      .insert(schema.chatopsBotsTable)
      .values({
        ...(input.id ? { id: input.id } : {}),
        organizationId: input.organizationId,
        provider: input.provider,
        name: input.name,
        secretId: input.secretId ?? null,
      })
      .returning();
    return bot as ChatOpsBot;
  }

  /**
   * Return the provider's bot, creating it on first use. Teams and Telegram are
   * backed by a unique index, so concurrent callers (several pods starting at
   * once) converge on one row instead of creating duplicates.
   */
  static async ensureDefault(params: {
    organizationId: string;
    provider: ChatOpsProviderType;
    name: string;
  }): Promise<ChatOpsBot> {
    const existing = await ChatOpsBotModel.findDefault(params);
    if (existing) return existing;

    await db
      .insert(schema.chatopsBotsTable)
      .values({
        organizationId: params.organizationId,
        provider: params.provider,
        name: params.name,
      })
      .onConflictDoNothing();

    const created = await ChatOpsBotModel.findDefault(params);
    if (!created) {
      throw new Error(
        `[ChatOpsBotModel] Could not create the ${params.provider} bot`,
      );
    }
    return created;
  }

  static async update(
    id: string,
    input: UpdateChatOpsBot,
  ): Promise<ChatOpsBot | null> {
    if (Object.keys(input).length === 0) {
      return ChatOpsBotModel.findById(id);
    }
    const [bot] = await db
      .update(schema.chatopsBotsTable)
      .set(input)
      .where(eq(schema.chatopsBotsTable.id, id))
      .returning();
    return (bot as ChatOpsBot) ?? null;
  }

  /** Deleting a bot drops its channel bindings and receipts (ON DELETE CASCADE). */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.chatopsBotsTable)
      .where(eq(schema.chatopsBotsTable.id, id));
    return (result.rowCount ?? 0) > 0;
  }
}

export default ChatOpsBotModel;
