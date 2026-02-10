import { eq, like, lt, or } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

/** Sessions not updated for this long are considered orphaned */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type McpHttpSessionRecord = {
  sessionId: string;
  sessionEndpointUrl: string | null;
  sessionEndpointPodName: string | null;
};

class McpHttpSessionModel {
  static async findByConnectionKey(
    connectionKey: string,
  ): Promise<string | null> {
    const session =
      await McpHttpSessionModel.findRecordByConnectionKey(connectionKey);
    return session?.sessionId ?? null;
  }

  static async findRecordByConnectionKey(
    connectionKey: string,
  ): Promise<McpHttpSessionRecord | null> {
    const result = await db
      .select({
        sessionId: schema.mcpHttpSessionsTable.sessionId,
        sessionEndpointUrl: schema.mcpHttpSessionsTable.sessionEndpointUrl,
        sessionEndpointPodName:
          schema.mcpHttpSessionsTable.sessionEndpointPodName,
      })
      .from(schema.mcpHttpSessionsTable)
      .where(eq(schema.mcpHttpSessionsTable.connectionKey, connectionKey))
      .limit(1);

    return result[0] ?? null;
  }

  static async upsert(params: {
    connectionKey: string;
    sessionId: string;
    sessionEndpointUrl?: string | null;
    sessionEndpointPodName?: string | null;
  }): Promise<void> {
    const {
      connectionKey,
      sessionId,
      sessionEndpointUrl = null,
      sessionEndpointPodName = null,
    } = params;

    await db
      .insert(schema.mcpHttpSessionsTable)
      .values({
        connectionKey,
        sessionId,
        sessionEndpointUrl,
        sessionEndpointPodName,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.mcpHttpSessionsTable.connectionKey,
        set: {
          sessionId,
          sessionEndpointUrl,
          sessionEndpointPodName,
          updatedAt: new Date(),
        },
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
   * Delete all sessions associated with a given MCP server ID.
   * Connection keys contain the mcpServerId as the second segment
   * (e.g. "catalogId:mcpServerId:agentId:conversationId" or "catalogId:mcpServerId").
   * Called when a server is restarted to invalidate stale session IDs.
   */
  static async deleteByMcpServerId(mcpServerId: string): Promise<number> {
    // Escape LIKE wildcards (%, _) in case the ID ever contains them
    const escapedId = mcpServerId.replace(/[%_\\]/g, "\\$&");
    // Match both key formats precisely:
    //   "catalogId:mcpServerId:agentId:conversationId" (4-segment)
    //   "catalogId:mcpServerId" (2-segment, must end at string boundary)
    const patternFull = `%:${escapedId}:%`;
    const patternShort = `%:${escapedId}`;
    const deleted = await db
      .delete(schema.mcpHttpSessionsTable)
      .where(
        or(
          like(schema.mcpHttpSessionsTable.connectionKey, patternFull),
          like(schema.mcpHttpSessionsTable.connectionKey, patternShort),
        ),
      )
      .returning({ connectionKey: schema.mcpHttpSessionsTable.connectionKey });

    if (deleted.length > 0) {
      logger.info(
        { mcpServerId, count: deleted.length },
        "Deleted MCP HTTP sessions for restarted server",
      );
    }
    return deleted.length;
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
