import { and, eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";

class ScheduleTriggerRunConversationModel {
  static async findConversationIdForUser(params: {
    runId: string;
    userId: string;
    txOrDb?: Transaction | typeof db;
  }): Promise<string | null> {
    const executor = params.txOrDb ?? db;
    const [mapping] = await executor
      .select({
        conversationId:
          schema.scheduleTriggerRunConversationsTable.conversationId,
      })
      .from(schema.scheduleTriggerRunConversationsTable)
      .where(
        and(
          eq(schema.scheduleTriggerRunConversationsTable.runId, params.runId),
          eq(schema.scheduleTriggerRunConversationsTable.userId, params.userId),
        ),
      );

    return mapping?.conversationId ?? null;
  }

  static async upsert(params: {
    runId: string;
    userId: string;
    chatConversationId: string;
    txOrDb?: Transaction | typeof db;
  }): Promise<void> {
    const executor = params.txOrDb ?? db;

    await executor
      .insert(schema.scheduleTriggerRunConversationsTable)
      .values({
        runId: params.runId,
        userId: params.userId,
        conversationId: params.chatConversationId,
      })
      .onConflictDoUpdate({
        target: [
          schema.scheduleTriggerRunConversationsTable.runId,
          schema.scheduleTriggerRunConversationsTable.userId,
        ],
        set: {
          conversationId: params.chatConversationId,
          updatedAt: new Date(),
        },
      });
  }
}

export default ScheduleTriggerRunConversationModel;
