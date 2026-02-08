import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

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
    logger.warn(
      { connectionKey },
      "Deleting stale MCP HTTP session (server likely restarted)",
    );
    await McpHttpSessionModel.deleteByConnectionKey(connectionKey);
  }
}

export default McpHttpSessionModel;
