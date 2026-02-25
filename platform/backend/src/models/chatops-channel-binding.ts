import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
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
        channelName: input.channelName ?? null,
        workspaceName: input.workspaceName ?? null,
        agentId: input.agentId,
        isDm: input.isDm ?? false,
        dmOwnerEmail: input.dmOwnerEmail ?? null,
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
      conditions.push(isNull(schema.chatopsChannelBindingsTable.workspaceId));
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
   * Update channel and workspace display names (internal use only).
   * Used by the name refresh mechanism — not exposed via API.
   */
  static async updateNames(
    id: string,
    names: { channelName?: string; workspaceName?: string },
  ): Promise<ChatOpsChannelBinding | null> {
    const setFields: Record<string, string> = {};
    if (names.channelName !== undefined) {
      setFields.channelName = names.channelName;
    }
    if (names.workspaceName !== undefined) {
      setFields.workspaceName = names.workspaceName;
    }

    if (Object.keys(setFields).length === 0) return null;

    const [binding] = await db
      .update(schema.chatopsChannelBindingsTable)
      .set(setFields)
      .where(eq(schema.chatopsChannelBindingsTable.id, id))
      .returning();

    return (binding as ChatOpsChannelBinding) || null;
  }

  /**
   * Update a binding by channel (upsert pattern)
   * Creates if not exists, updates if exists.
   *
   * For DM bindings: removes stale bindings for the same user+provider
   * with a different channelId (Slack/Teams can assign new channel IDs
   * when a user re-initiates a DM conversation).
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
      const setFields: Record<string, unknown> = {};
      if (input.agentId !== undefined) setFields.agentId = input.agentId;
      if (input.channelName !== undefined)
        setFields.channelName = input.channelName;
      if (input.workspaceName !== undefined)
        setFields.workspaceName = input.workspaceName;
      if (input.isDm !== undefined) setFields.isDm = input.isDm;
      if (input.dmOwnerEmail !== undefined)
        setFields.dmOwnerEmail = input.dmOwnerEmail;

      if (Object.keys(setFields).length > 0) {
        const [updated] = await db
          .update(schema.chatopsChannelBindingsTable)
          .set(setFields)
          .where(eq(schema.chatopsChannelBindingsTable.id, existing.id))
          .returning();
        return (updated as ChatOpsChannelBinding) ?? existing;
      }
      return existing;
    }

    // For DM bindings, remove stale entries for the same user before creating
    // a new one. Slack/Teams can assign new channel IDs when a user
    // re-initiates a DM, leading to duplicate rows for the same person.
    if (input.isDm && input.dmOwnerEmail) {
      const deleted = await db
        .delete(schema.chatopsChannelBindingsTable)
        .where(
          and(
            eq(
              schema.chatopsChannelBindingsTable.organizationId,
              input.organizationId,
            ),
            eq(schema.chatopsChannelBindingsTable.provider, input.provider),
            eq(schema.chatopsChannelBindingsTable.isDm, true),
            eq(
              schema.chatopsChannelBindingsTable.dmOwnerEmail,
              input.dmOwnerEmail,
            ),
            ne(schema.chatopsChannelBindingsTable.channelId, input.channelId),
          ),
        )
        .returning();

      if (deleted.length > 0) {
        logger.debug(
          {
            provider: input.provider,
            dmOwnerEmail: input.dmOwnerEmail,
            deletedCount: deleted.length,
          },
          "[ChatOpsChannelBinding] Removed stale DM bindings",
        );
      }
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

  /**
   * Batch upsert discovered channels.
   * Creates bindings with agentId=null for new channels,
   * updates channelName/workspaceName for existing ones (preserves agentId).
   */
  static async ensureChannelsExist(params: {
    organizationId: string;
    provider: ChatOpsProviderType;
    channels: Array<{
      channelId: string;
      channelName: string | null;
      workspaceId: string | null;
      workspaceName: string | null;
    }>;
  }): Promise<void> {
    if (params.channels.length === 0) return;

    const values = params.channels.map((ch) => ({
      organizationId: params.organizationId,
      provider: params.provider,
      channelId: ch.channelId,
      workspaceId: ch.workspaceId,
      channelName: ch.channelName,
      workspaceName: ch.workspaceName,
    }));

    await db
      .insert(schema.chatopsChannelBindingsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.chatopsChannelBindingsTable.provider,
          schema.chatopsChannelBindingsTable.channelId,
          schema.chatopsChannelBindingsTable.workspaceId,
        ],
        set: {
          channelName: sql`excluded.channel_name`,
          workspaceName: sql`excluded.workspace_name`,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Set workspaceName on all bindings for a provider where it is currently null.
   * If an explicit workspaceName is provided, uses that directly.
   * Otherwise, infers the name from sibling bindings that already have one
   * (useful for MS Teams DMs that lack workspace context).
   */
  static async backfillWorkspaceName(params: {
    provider: ChatOpsProviderType;
    workspaceName?: string;
  }): Promise<void> {
    if (params.workspaceName) {
      await db
        .update(schema.chatopsChannelBindingsTable)
        .set({ workspaceName: params.workspaceName, updatedAt: new Date() })
        .where(
          and(
            eq(schema.chatopsChannelBindingsTable.provider, params.provider),
            isNull(schema.chatopsChannelBindingsTable.workspaceName),
          ),
        );
      return;
    }

    // Infer from sibling bindings: pick the most common workspace name for this provider
    const [result] = await db
      .select({
        workspaceName: schema.chatopsChannelBindingsTable.workspaceName,
      })
      .from(schema.chatopsChannelBindingsTable)
      .where(
        and(
          eq(schema.chatopsChannelBindingsTable.provider, params.provider),
          sql`${schema.chatopsChannelBindingsTable.workspaceName} IS NOT NULL`,
        ),
      )
      .groupBy(schema.chatopsChannelBindingsTable.workspaceName)
      .orderBy(sql`count(*) DESC`)
      .limit(1);

    if (result?.workspaceName) {
      await db
        .update(schema.chatopsChannelBindingsTable)
        .set({ workspaceName: result.workspaceName, updatedAt: new Date() })
        .where(
          and(
            eq(schema.chatopsChannelBindingsTable.provider, params.provider),
            isNull(schema.chatopsChannelBindingsTable.workspaceName),
          ),
        );
    }
  }

  /**
   * Remove bindings for channels that no longer exist in Teams.
   * Accepts multiple workspace IDs to handle the case where the same team
   * has bindings stored with different ID formats (UUID aadGroupId vs thread ID).
   * Returns the count of deleted rows.
   */
  static async deleteStaleChannels(params: {
    organizationId: string;
    provider: ChatOpsProviderType;
    workspaceIds: string[];
    activeChannelIds: string[];
  }): Promise<number> {
    if (
      params.activeChannelIds.length === 0 ||
      params.workspaceIds.length === 0
    )
      return 0;

    const deleted = await db
      .delete(schema.chatopsChannelBindingsTable)
      .where(
        and(
          eq(
            schema.chatopsChannelBindingsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.chatopsChannelBindingsTable.provider, params.provider),
          inArray(
            schema.chatopsChannelBindingsTable.workspaceId,
            params.workspaceIds,
          ),
          notInArray(
            schema.chatopsChannelBindingsTable.channelId,
            params.activeChannelIds,
          ),
          // Exclude DM bindings from cleanup — they won't appear in the
          // active channel discovery list but should be preserved.
          eq(schema.chatopsChannelBindingsTable.isDm, false),
        ),
      )
      .returning();

    return deleted.length;
  }

  /**
   * Delete duplicate bindings for the same (provider, channelId) that have
   * a different workspaceId than the canonical one. This cleans up duplicates
   * caused by the same team being identified by both UUID (aadGroupId) and
   * thread-format IDs at different times.
   */
  static async deleteDuplicateBindings(params: {
    provider: ChatOpsProviderType;
    channelId: string;
    canonicalBindingId: string;
  }): Promise<number> {
    const deleted = await db
      .delete(schema.chatopsChannelBindingsTable)
      .where(
        and(
          eq(schema.chatopsChannelBindingsTable.provider, params.provider),
          eq(schema.chatopsChannelBindingsTable.channelId, params.channelId),
          ne(schema.chatopsChannelBindingsTable.id, params.canonicalBindingId),
        ),
      )
      .returning();

    return deleted.length;
  }

  /**
   * Deduplicate bindings for a batch of channels.
   * For each (provider, channelId) with multiple rows, keeps the one with an
   * agent assigned (preferring the most recently updated), and deletes the rest.
   */
  static async deduplicateBindings(params: {
    provider: ChatOpsProviderType;
    channelIds: string[];
  }): Promise<number> {
    if (params.channelIds.length === 0) return 0;

    // Find all bindings for these channels
    const bindings = await db
      .select()
      .from(schema.chatopsChannelBindingsTable)
      .where(
        and(
          eq(schema.chatopsChannelBindingsTable.provider, params.provider),
          inArray(
            schema.chatopsChannelBindingsTable.channelId,
            params.channelIds,
          ),
        ),
      );

    // Group by channelId
    const byChannel = new Map<string, typeof bindings>();
    for (const b of bindings) {
      const list = byChannel.get(b.channelId) ?? [];
      list.push(b);
      byChannel.set(b.channelId, list);
    }

    // For each channel with duplicates, keep the best one and delete the rest
    const idsToDelete: string[] = [];
    for (const [, group] of byChannel) {
      if (group.length <= 1) continue;

      // Prefer binding with agent assigned, then most recently updated
      group.sort((a, b) => {
        if (a.agentId && !b.agentId) return -1;
        if (!a.agentId && b.agentId) return 1;
        return b.updatedAt.getTime() - a.updatedAt.getTime();
      });

      // Keep the first (best), delete the rest
      for (let i = 1; i < group.length; i++) {
        idsToDelete.push(group[i].id);
      }
    }

    if (idsToDelete.length === 0) return 0;

    const deleted = await db
      .delete(schema.chatopsChannelBindingsTable)
      .where(inArray(schema.chatopsChannelBindingsTable.id, idsToDelete))
      .returning();

    return deleted.length;
  }
}

export default ChatOpsChannelBindingModel;
