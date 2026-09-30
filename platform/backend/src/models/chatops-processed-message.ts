import { and, eq, isNull, lt } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { isUniqueConstraintError } from "@/utils/db";

/**
 * Model for tracking processed chatops messages.
 *
 * Uses database with unique constraint for atomic, distributed deduplication
 * across multiple pod replicas. Same pattern as ProcessedEmailModel.
 */
class ChatOpsProcessedMessageModel {
  /**
   * Attempt to mark a message as processed by one bot.
   * Uses INSERT with unique constraint for atomic deduplication. The claim is
   * scoped to the bot: one delivery that reaches two bots is processed once
   * per bot, and neither bot's claim can swallow the other's copy.
   *
   * @param params.botId - The bot claiming the message
   * @param params.messageId - The provider's message ID
   * @returns true if successfully marked (first to process), false if already processed
   */
  static async tryMarkAsProcessed(params: {
    botId: string;
    messageId: string;
  }): Promise<boolean> {
    try {
      await db.insert(schema.chatopsProcessedMessagesTable).values({
        botId: params.botId,
        messageId: params.messageId,
      });
      return true;
    } catch (error) {
      // Check if this is a unique constraint violation (message already processed)
      if (isUniqueConstraintError(error)) {
        return false;
      }
      // Re-throw unexpected errors
      throw error;
    }
  }

  /**
   * Check if a message has been processed.
   * Note: For deduplication, prefer tryMarkAsProcessed() which is atomic.
   * This method is mainly for debugging/monitoring.
   *
   * @param params.botId - The bot whose claim is checked
   * @param params.messageId - The provider's message ID
   * @returns true if the message has been processed
   */
  static async isProcessed(params: {
    botId: string | null;
    messageId: string;
  }): Promise<boolean> {
    const [record] = await db
      .select({ id: schema.chatopsProcessedMessagesTable.id })
      .from(schema.chatopsProcessedMessagesTable)
      .where(
        and(
          params.botId === null
            ? isNull(schema.chatopsProcessedMessagesTable.botId)
            : eq(schema.chatopsProcessedMessagesTable.botId, params.botId),
          eq(schema.chatopsProcessedMessagesTable.messageId, params.messageId),
        ),
      )
      .limit(1);

    return !!record;
  }

  /**
   * Delete old processed message records.
   * Should be called periodically to prevent unbounded table growth.
   *
   * @param olderThan - Delete records older than this date
   * @returns Number of records deleted
   */
  static async cleanupOldRecords(olderThan: Date): Promise<number> {
    const result = await db
      .delete(schema.chatopsProcessedMessagesTable)
      .where(lt(schema.chatopsProcessedMessagesTable.processedAt, olderThan));

    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      logger.info(
        { deleted, olderThan },
        "[ChatOpsProcessedMessage] Cleaned up old records",
      );
    }

    return deleted;
  }
}

export default ChatOpsProcessedMessageModel;
