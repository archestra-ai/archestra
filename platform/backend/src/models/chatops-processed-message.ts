import { eq, lt } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

/**
 * Model for tracking processed chatops messages.
 *
 * Uses database with unique constraint for atomic, distributed deduplication
 * across multiple pod replicas. Same pattern as ProcessedEmailModel.
 */
class ChatOpsProcessedMessageModel {
  /**
   * Attempt to mark a message as processed.
   * Uses INSERT with unique constraint for atomic deduplication.
   *
   * @param messageId - The provider's message ID
   * @returns true if successfully marked (first to process), false if already processed
   */
  static async tryMarkAsProcessed(messageId: string): Promise<boolean> {
    try {
      await db
        .insert(schema.chatopsProcessedMessagesTable)
        .values({ messageId });
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
   * @param messageId - The provider's message ID
   * @returns true if the message has been processed
   */
  static async isProcessed(messageId: string): Promise<boolean> {
    const [record] = await db
      .select({ id: schema.chatopsProcessedMessagesTable.id })
      .from(schema.chatopsProcessedMessagesTable)
      .where(eq(schema.chatopsProcessedMessagesTable.messageId, messageId))
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

/**
 * Check if an error (or its cause) is a PostgreSQL unique constraint violation.
 * Drizzle wraps database errors, so we need to check the cause chain.
 */
function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Check the error itself
  const errorCode = (error as { code?: string }).code;
  const errorMessage = error.message.toLowerCase();

  if (
    errorCode === "23505" || // PostgreSQL unique_violation error code
    errorMessage.includes("duplicate key") ||
    errorMessage.includes("unique constraint") ||
    errorMessage.includes("unique_violation")
  ) {
    return true;
  }

  // Check the cause (Drizzle wraps errors)
  const cause = (error as { cause?: unknown }).cause;
  if (cause) {
    return isUniqueConstraintError(cause);
  }

  return false;
}

export default ChatOpsProcessedMessageModel;
