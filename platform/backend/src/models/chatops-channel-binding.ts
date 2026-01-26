import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ChatOpsProviderType } from "@/types/chatops";
import type {
  ChatOpsChannelBinding,
  InsertChatOpsChannelBinding,
  UpdateChatOpsChannelBinding,
} from "@/types/chatops-channel-binding";

/**
 * Model for managing chatops channel bindings.
 * Maps chat channels (Teams, Slack, etc.) to Archestra internal agents.
 */
class ChatOpsChannelBindingModel {
  /**
   * Create a new channel binding
   */
  static async create(
    input: InsertChatOpsChannelBinding,
  ): Promise<ChatOpsChannelBinding> {
    const [binding] = await db
      .insert(schema.chatopsChannelBindingsTable)
      .values({
        organizationId: input.organizationId,
        provider: input.provider,
        channelId: input.channelId,
        workspaceId: input.workspaceId ?? null,
        agentId: input.agentId,
      })
      .returning();

    return binding as ChatOpsChannelBinding;
  }

  /**
   * Find a binding by provider, channel ID, and workspace ID
   * This is the primary lookup method for message routing
   */
  static async findByChannel(params: {
    provider: ChatOpsProviderType;
    channelId: string;
    workspaceId: string | null;
  }): Promise<ChatOpsChannelBinding | null> {
    const conditions = [
      eq(schema.chatopsChannelBindingsTable.provider, params.provider),
      eq(schema.chatopsChannelBindingsTable.channelId, params.channelId),
    ];

    // Handle nullable workspaceId
    if (params.workspaceId) {
      conditions.push(
        eq(schema.chatopsChannelBindingsTable.workspaceId, params.workspaceId),
      );
    } else {
      // For null workspaceId, we need to check for null explicitly
      // but Drizzle doesn't have a direct isNull, so we use raw SQL
      const [binding] = await db
        .select()
        .from(schema.chatopsChannelBindingsTable)
        .where(
          and(
            eq(schema.chatopsChannelBindingsTable.provider, params.provider),
            eq(schema.chatopsChannelBindingsTable.channelId, params.channelId),
          ),
        )
        .limit(1);

      // Filter by null workspaceId in JS since it's an edge case
      if (binding && binding.workspaceId === null) {
        return binding as ChatOpsChannelBinding;
      }

      return null;
    }

    const [binding] = await db
      .select()
      .from(schema.chatopsChannelBindingsTable)
      .where(and(...conditions))
      .limit(1);

    return (binding as ChatOpsChannelBinding) || null;
  }

  /**
   * Find a binding by ID
   */
  static async findById(id: string): Promise<ChatOpsChannelBinding | null> {
    const [binding] = await db
      .select()
      .from(schema.chatopsChannelBindingsTable)
      .where(eq(schema.chatopsChannelBindingsTable.id, id));

    return (binding as ChatOpsChannelBinding) || null;
  }

  /**
   * Find a binding by ID and organization
   */
  static async findByIdAndOrganization(
    id: string,
    organizationId: string,
  ): Promise<ChatOpsChannelBinding | null> {
    const [binding] = await db
      .select()
      .from(schema.chatopsChannelBindingsTable)
      .where(
        and(
          eq(schema.chatopsChannelBindingsTable.id, id),
          eq(schema.chatopsChannelBindingsTable.organizationId, organizationId),
        ),
      );

    return (binding as ChatOpsChannelBinding) || null;
  }

  /**
   * Find all bindings for an organization
   */
  static async findByOrganization(
    organizationId: string,
  ): Promise<ChatOpsChannelBinding[]> {
    const bindings = await db
      .select()
      .from(schema.chatopsChannelBindingsTable)
      .where(
        eq(schema.chatopsChannelBindingsTable.organizationId, organizationId),
      )
      .orderBy(desc(schema.chatopsChannelBindingsTable.createdAt));

    return bindings as ChatOpsChannelBinding[];
  }

  /**
   * Find all bindings for a specific agent
   */
  static async findByAgentId(
    agentId: string,
  ): Promise<ChatOpsChannelBinding[]> {
    const bindings = await db
      .select()
      .from(schema.chatopsChannelBindingsTable)
      .where(eq(schema.chatopsChannelBindingsTable.agentId, agentId))
      .orderBy(desc(schema.chatopsChannelBindingsTable.createdAt));

    return bindings as ChatOpsChannelBinding[];
  }

  /**
   * Update a channel binding
   */
  static async update(
    id: string,
    input: UpdateChatOpsChannelBinding,
  ): Promise<ChatOpsChannelBinding | null> {
    const [binding] = await db
      .update(schema.chatopsChannelBindingsTable)
      .set({
        ...(input.agentId !== undefined && { agentId: input.agentId }),
      })
      .where(eq(schema.chatopsChannelBindingsTable.id, id))
      .returning();

    return (binding as ChatOpsChannelBinding) || null;
  }

  /**
   * Update a binding by channel (upsert pattern)
   * Creates if not exists, updates if exists
   */
  static async upsertByChannel(
    input: InsertChatOpsChannelBinding,
  ): Promise<ChatOpsChannelBinding> {
    const existing = await ChatOpsChannelBindingModel.findByChannel({
      provider: input.provider,
      channelId: input.channelId,
      workspaceId: input.workspaceId ?? null,
    });

    if (existing) {
      const updated = await ChatOpsChannelBindingModel.update(existing.id, {
        agentId: input.agentId,
      });
      if (!updated) {
        throw new Error("Failed to update binding");
      }
      return updated;
    }

    return ChatOpsChannelBindingModel.create(input);
  }

  /**
   * Delete a binding by ID
   */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.chatopsChannelBindingsTable)
      .where(eq(schema.chatopsChannelBindingsTable.id, id));

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Delete a binding by ID and organization
   */
  static async deleteByIdAndOrganization(
    id: string,
    organizationId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.chatopsChannelBindingsTable)
      .where(
        and(
          eq(schema.chatopsChannelBindingsTable.id, id),
          eq(schema.chatopsChannelBindingsTable.organizationId, organizationId),
        ),
      );

    return (result.rowCount ?? 0) > 0;
  }
}

export default ChatOpsChannelBindingModel;
