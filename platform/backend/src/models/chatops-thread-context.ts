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
}

export default ChatOpsThreadContextModel;
