import { and, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ChatOpsThreadConversation } from "@/types/chatops-thread-conversation";

/**
 * Model mapping a ChatOps thread (binding + effective thread id) to its
 * persisted chat conversation. The mapping is created once per thread with a
 * CAS insert; concurrent creators race on the unique (bindingId, threadId)
 * index and the loser adopts the winner's row (the caller deletes its orphan
 * conversation — see the chatops conversation service).
 */
class ChatOpsThreadConversationModel {
  /**
   * Insert the mapping unless one already exists for (bindingId, threadId).
   * Returns the winning row either way, plus whether this call created it.
   */
  static async createIfAbsent(params: {
    bindingId: string;
    threadId: string;
    conversationId: string;
  }): Promise<{ mapping: ChatOpsThreadConversation; created: boolean }> {
    const [inserted] = await db
      .insert(schema.chatopsThreadConversationsTable)
      .values(params)
      .onConflictDoNothing({
        target: [
          schema.chatopsThreadConversationsTable.bindingId,
          schema.chatopsThreadConversationsTable.threadId,
        ],
      })
      .returning();

    if (inserted) {
      return { mapping: inserted as ChatOpsThreadConversation, created: true };
    }

    const existing =
      await ChatOpsThreadConversationModel.findByBindingAndThread(
        params.bindingId,
        params.threadId,
      );
    if (!existing) {
      // The conflicting row vanished between insert and select (deleted
      // concurrently). Surface it — the caller cleans up its orphan
      // conversation and the turn fails visibly.
      throw new Error(
        "chatops thread conversation mapping disappeared during CAS create",
      );
    }
    return { mapping: existing, created: false };
  }

  static async findByBindingAndThread(
    bindingId: string,
    threadId: string,
  ): Promise<ChatOpsThreadConversation | null> {
    const [mapping] = await db
      .select()
      .from(schema.chatopsThreadConversationsTable)
      .where(
        and(
          eq(schema.chatopsThreadConversationsTable.bindingId, bindingId),
          eq(schema.chatopsThreadConversationsTable.threadId, threadId),
        ),
      )
      .limit(1);

    return (mapping as ChatOpsThreadConversation) ?? null;
  }

  /**
   * Compare-and-set advance of the provider-ingestion high-water mark.
   * Returns false when the stored cursor no longer matches `expectedTs`
   * (a concurrent turn advanced it first) — the caller must not treat its
   * delta as ingested.
   */
  static async advanceLastSyncedProviderTs(params: {
    id: string;
    expectedTs: string | null;
    newTs: string;
  }): Promise<boolean> {
    const cursorMatches =
      params.expectedTs === null
        ? isNull(schema.chatopsThreadConversationsTable.lastSyncedProviderTs)
        : eq(
            schema.chatopsThreadConversationsTable.lastSyncedProviderTs,
            params.expectedTs,
          );
    const result = await db
      .update(schema.chatopsThreadConversationsTable)
      .set({ lastSyncedProviderTs: params.newTs })
      .where(
        and(
          eq(schema.chatopsThreadConversationsTable.id, params.id),
          cursorMatches,
        ),
      )
      .returning({ id: schema.chatopsThreadConversationsTable.id });

    return result.length > 0;
  }
}

export default ChatOpsThreadConversationModel;
