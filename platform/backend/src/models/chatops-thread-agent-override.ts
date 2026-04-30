import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ChatOpsThreadAgentOverride } from "@/types/chatops-thread-agent-override";

/**
 * Model for managing per-thread agent overrides in chatops channels.
 *
 * When swap_agent is called during a ChatOps conversation, the override is
 * stored here instead of mutating the shared channel binding. This ensures
 * swaps are scoped to the active thread/conversation.
 */
class ChatOpsThreadAgentOverrideModel {
  /**
   * Upsert (insert or update) a thread-level agent override.
   * Uses the unique (bindingId, threadId) constraint for conflict resolution.
   */
  static async upsert(
    bindingId: string,
    threadId: string,
    agentId: string,
  ): Promise<ChatOpsThreadAgentOverride | null> {
    const [override] = await db
      .insert(schema.chatopsThreadAgentOverrideTable)
      .values({ bindingId, threadId, agentId })
      .onConflictDoUpdate({
        target: [
          schema.chatopsThreadAgentOverrideTable.bindingId,
          schema.chatopsThreadAgentOverrideTable.threadId,
        ],
        set: { agentId, updatedAt: new Date() },
      })
      .returning();

    return (override as ChatOpsThreadAgentOverride) ?? null;
  }

  /**
   * Find the active agent override for a specific thread.
   */
  static async findByThread(
    bindingId: string,
    threadId: string,
  ): Promise<ChatOpsThreadAgentOverride | null> {
    const [override] = await db
      .select()
      .from(schema.chatopsThreadAgentOverrideTable)
      .where(
        and(
          eq(schema.chatopsThreadAgentOverrideTable.bindingId, bindingId),
          eq(schema.chatopsThreadAgentOverrideTable.threadId, threadId),
        ),
      )
      .limit(1);

    return (override as ChatOpsThreadAgentOverride) ?? null;
  }

  /**
   * Delete override for a thread.
   */
  static async deleteByThread(
    bindingId: string,
    threadId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.chatopsThreadAgentOverrideTable)
      .where(
        and(
          eq(schema.chatopsThreadAgentOverrideTable.bindingId, bindingId),
          eq(schema.chatopsThreadAgentOverrideTable.threadId, threadId),
        ),
      )
      .returning();

    return result.length > 0;
  }
}

export default ChatOpsThreadAgentOverrideModel;
