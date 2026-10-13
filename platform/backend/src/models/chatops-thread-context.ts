import { and, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ChatOpsThreadContext,
  InsertChatOpsThreadContext,
} from "@/types/chatops-thread-context";

class ChatOpsThreadContextModel {
  static async findByThread(params: {
    provider: ChatOpsThreadContext["provider"];
    channelId: string;
    workspaceId: string | null;
    threadId: string;
  }): Promise<ChatOpsThreadContext | null> {
    const [record] = await db
      .select()
      .from(schema.chatopsThreadContextsTable)
      .where(
        and(
          eq(schema.chatopsThreadContextsTable.provider, params.provider),
          eq(schema.chatopsThreadContextsTable.channelId, params.channelId),
          params.workspaceId === null
            ? isNull(schema.chatopsThreadContextsTable.workspaceId)
            : eq(
                schema.chatopsThreadContextsTable.workspaceId,
                params.workspaceId,
              ),
          eq(schema.chatopsThreadContextsTable.threadId, params.threadId),
        ),
      )
      .limit(1);

    return record ?? null;
  }

  /**
   * Insert the mapping, tolerating a concurrent insert for the same thread:
   * on conflict the existing row wins and is returned (the caller's freshly
   * created context is left orphaned, which is harmless — it holds nothing).
   */
  static async createOrGet(
    data: InsertChatOpsThreadContext,
  ): Promise<ChatOpsThreadContext> {
    const [inserted] = await db
      .insert(schema.chatopsThreadContextsTable)
      .values(data)
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return inserted;
    }

    const existing = await ChatOpsThreadContextModel.findByThread({
      provider: data.provider,
      channelId: data.channelId,
      workspaceId: data.workspaceId ?? null,
      threadId: data.threadId,
    });
    if (!existing) {
      // Only reachable if the conflicting row was deleted between the insert
      // and the read — retrying from scratch is the caller's concern.
      throw new Error(
        "[ChatOpsThreadContextModel] Thread context mapping vanished after conflict",
      );
    }
    return existing;
  }

  /**
   * Remove a thread's mapping (a reset), returning the removed row. The
   * context it pointed at is kept; the next message creates a new one.
   */
  static async deleteByThread(params: {
    provider: ChatOpsThreadContext["provider"];
    channelId: string;
    workspaceId: string | null;
    threadId: string;
  }): Promise<ChatOpsThreadContext | null> {
    const [removed] = await db
      .delete(schema.chatopsThreadContextsTable)
      .where(
        and(
          eq(schema.chatopsThreadContextsTable.provider, params.provider),
          eq(schema.chatopsThreadContextsTable.channelId, params.channelId),
          params.workspaceId === null
            ? isNull(schema.chatopsThreadContextsTable.workspaceId)
            : eq(
                schema.chatopsThreadContextsTable.workspaceId,
                params.workspaceId,
              ),
          eq(schema.chatopsThreadContextsTable.threadId, params.threadId),
        ),
      )
      .returning();

    return removed ?? null;
  }

  /**
   * Point an existing mapping at a new context (an idle rollover),
   * only if it still points at `expectedContextId`. Returns null when a
   * concurrent message already moved it, so the caller re-reads the winner
   * instead of overwriting it. The old context is kept, not deleted.
   */
  static async replaceContext(params: {
    id: string;
    expectedContextId: string;
    contextId: string;
  }): Promise<ChatOpsThreadContext | null> {
    const [updated] = await db
      .update(schema.chatopsThreadContextsTable)
      .set({ contextId: params.contextId })
      .where(
        and(
          eq(schema.chatopsThreadContextsTable.id, params.id),
          eq(
            schema.chatopsThreadContextsTable.contextId,
            params.expectedContextId,
          ),
        ),
      )
      .returning();

    return updated ?? null;
  }
}

export default ChatOpsThreadContextModel;
