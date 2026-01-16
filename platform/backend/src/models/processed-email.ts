import { eq, lt } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

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

/**
 * Model for tracking processed incoming emails.
 *
 * Uses database with unique constraint for atomic, distributed deduplication
 * across multiple pod replicas. The unique constraint on messageId ensures
 * only the first INSERT succeeds, preventing race conditions.
 */
class ProcessedEmailModel {
  /**
   * Attempt to mark an email as processed.
   * Uses INSERT with unique constraint for atomic deduplication.
   *
   * @param messageId - The email provider's message ID
   * @returns true if successfully marked (first to process), false if already processed
   */
  static async tryMarkAsProcessed(messageId: string): Promise<boolean> {
    try {
      await db.insert(schema.processedEmailsTable).values({ messageId });
      return true;
    } catch (error) {
      // Check if this is a unique constraint violation (email already processed)
      // Different database drivers/wrappers may format the error differently:
      // - PostgreSQL native: "duplicate key value"
      // - PGlite: error code "23505" (unique_violation)
      // - Drizzle wraps errors, so check cause too
      if (isUniqueConstraintError(error)) {
        return false;
      }
      // Re-throw unexpected errors
      throw error;
    }
  }

  /**
   * Check if an email has been processed.
   * Note: For deduplication, prefer tryMarkAsProcessed() which is atomic.
   * This method is mainly for debugging/monitoring.
   *
   * @param messageId - The email provider's message ID
   * @returns true if the email has been processed
   */
  static async isProcessed(messageId: string): Promise<boolean> {
    const [record] = await db
      .select({ id: schema.processedEmailsTable.id })
      .from(schema.processedEmailsTable)
      .where(eq(schema.processedEmailsTable.messageId, messageId))
      .limit(1);

    return !!record;
  }

  /**
   * Delete old processed email records.
   * Should be called periodically to prevent unbounded table growth.
   *
   * @param olderThan - Delete records older than this date
   * @returns Number of records deleted
   */
  static async cleanupOldRecords(olderThan: Date): Promise<number> {
    const result = await db
      .delete(schema.processedEmailsTable)
      .where(lt(schema.processedEmailsTable.processedAt, olderThan));

    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      logger.info(
        { deleted, olderThan },
        "[ProcessedEmail] Cleaned up old records",
      );
    }

    return deleted;
  }
}

export default ProcessedEmailModel;
