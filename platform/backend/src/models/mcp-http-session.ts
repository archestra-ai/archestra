import { eq, lt } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

/** Sessions not updated for this long are considered orphaned */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

class McpHttpSessionModel {
  static async findByConnectionKey(
    connectionKey: string,
  ): Promise<string | null> {
    const result = await db
      .select({ sessionId: schema.mcpHttpSessionsTable.sessionId })
      .from(schema.mcpHttpSessionsTable)
      .where(eq(schema.mcpHttpSessionsTable.connectionKey, connectionKey))
      .limit(1);

    return result[0]?.sessionId ?? null;
  }

  static async upsert(connectionKey: string, sessionId: string): Promise<void> {
    await db
      .insert(schema.mcpHttpSessionsTable)
      .values({ connectionKey, sessionId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.mcpHttpSessionsTable.connectionKey,
        set: { sessionId, updatedAt: new Date() },
      });
  }

  static async deleteByConnectionKey(connectionKey: string): Promise<void> {
    await db
      .delete(schema.mcpHttpSessionsTable)
      .where(eq(schema.mcpHttpSessionsTable.connectionKey, connectionKey));
  }

  /**
   * Delete stale session and log a warning.
   * Called when a stored session ID is no longer valid (e.g. Playwright pod restarted).
   */
  static async deleteStaleSession(connectionKey: string): Promise<void> {
    await McpHttpSessionModel.deleteByConnectionKey(connectionKey);
    logger.warn(
      { connectionKey },
      "Deleted stale MCP HTTP session (server likely restarted)",
    );
  }

  /**
   * Delete sessions not updated within the TTL window.
   * Called on startup to prevent unbounded table growth from orphaned sessions.
   */
  static async deleteExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - SESSION_TTL_MS);
    const deleted = await db
      .delete(schema.mcpHttpSessionsTable)
      .where(lt(schema.mcpHttpSessionsTable.updatedAt, cutoff))
      .returning({ connectionKey: schema.mcpHttpSessionsTable.connectionKey });

    if (deleted.length > 0) {
      logger.info(
        { count: deleted.length },
        "Cleaned up expired MCP HTTP sessions",
      );
    }
    return deleted.length;
  }
}

export default McpHttpSessionModel;
