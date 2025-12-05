import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { InsertSession, UpdateSession } from "@/types";

class SessionModel {
  /**
   * Get all sessions
   */
  static async getAll() {
    logger.debug("SessionModel.getAll: fetching all sessions");
    const sessions = await db.select().from(schema.sessionsTable);
    logger.debug({ count: sessions.length }, "SessionModel.getAll: completed");
    return sessions;
  }

  /**
   * Get all sessions for a user
   */
  static async getByUserId(userId: string) {
    logger.debug({ userId }, "SessionModel.getByUserId: fetching sessions");
    const sessions = await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, userId));
    logger.debug(
      { userId, count: sessions.length },
      "SessionModel.getByUserId: completed",
    );
    return sessions;
  }

  /**
   * Get a session by ID
   */
  static async getById(id: string) {
    logger.debug({ id }, "SessionModel.getById: fetching session");
    const sessions = await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.id, id))
      .limit(1);
    logger.debug(
      { id, found: sessions.length > 0 },
      "SessionModel.getById: completed",
    );
    return sessions;
  }

  /**
   * Create a new session
   */
  static async create(data: InsertSession) {
    logger.debug(
      { userId: data.userId },
      "SessionModel.create: creating session",
    );
    const [session] = await db
      .insert(schema.sessionsTable)
      .values(data)
      .returning();
    logger.debug({ sessionId: session.id }, "SessionModel.create: completed");
    return session;
  }

  /**
   * Update a session with partial data
   */
  static async patch(sessionId: string, data: Partial<UpdateSession>) {
    logger.debug(
      { sessionId, dataKeys: Object.keys(data) },
      "SessionModel.patch: updating session",
    );
    const result = await db
      .update(schema.sessionsTable)
      .set(data)
      .where(eq(schema.sessionsTable.id, sessionId));
    logger.debug({ sessionId }, "SessionModel.patch: completed");
    return result;
  }

  /**
   * Delete all sessions for a user
   */
  static async deleteAllByUserId(userId: string) {
    logger.debug(
      { userId },
      "SessionModel.deleteAllByUserId: deleting sessions",
    );
    const result = await db
      .delete(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, userId));
    logger.debug({ userId }, "SessionModel.deleteAllByUserId: completed");
    return result;
  }
}

export default SessionModel;
