import { and, eq, inArray, ne, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
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
  static async getById(id: string, tx?: Transaction) {
    logger.debug({ id }, "SessionModel.getById: fetching session");
    const dbOrTx = tx ?? db;
    const sessions = await dbOrTx
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

  static async getByToken(token: string, tx?: Transaction) {
    logger.debug("SessionModel.getByToken: fetching session");
    const dbOrTx = tx ?? db;
    const [session] = await dbOrTx
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.token, token))
      .limit(1);
    logger.debug({ found: !!session }, "SessionModel.getByToken: completed");
    return session ?? null;
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
   * Delete a session by ID
   */
  static async deleteById(id: string, tx?: Transaction) {
    logger.debug({ id }, "SessionModel.deleteById: deleting session");
    const dbOrTx = tx ?? db;
    const result = await dbOrTx
      .delete(schema.sessionsTable)
      .where(eq(schema.sessionsTable.id, id));
    logger.debug({ id }, "SessionModel.deleteById: completed");
    return result;
  }

  /**
   * Delete all sessions for a user
   */
  static async deleteAllByUserId(userId: string, tx?: Transaction) {
    logger.debug(
      { userId },
      "SessionModel.deleteAllByUserId: deleting sessions",
    );
    const dbOrTx = tx ?? db;
    const result = await dbOrTx
      .delete(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, userId));
    logger.debug({ userId }, "SessionModel.deleteAllByUserId: completed");
    return result;
  }

  /**
   * Revoke every session belonging to a member of the organization whose
   * account has NOT enrolled in two-factor authentication. Used when an org
   * turns require-2FA on: those members must sign in again and land in
   * mandatory enrollment. Matching is by org MEMBERSHIP (not the session's
   * activeOrganizationId, which can be null before the create-hook stamps
   * it). Returns the number of revoked sessions.
   */
  static async deleteAllForOrganizationMembersWithoutTwoFactor(
    organizationId: string,
  ): Promise<number> {
    const memberUserIdsWithoutTwoFactor = db
      .select({ userId: schema.membersTable.userId })
      .from(schema.membersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.membersTable.userId, schema.usersTable.id),
      )
      .where(
        and(
          eq(schema.membersTable.organizationId, organizationId),
          // The column is nullable with default false — null means not enrolled.
          ne(sql`COALESCE(${schema.usersTable.twoFactorEnabled}, false)`, true),
        ),
      );

    const deleted = await db
      .delete(schema.sessionsTable)
      .where(
        inArray(schema.sessionsTable.userId, memberUserIdsWithoutTwoFactor),
      )
      .returning({ id: schema.sessionsTable.id });
    logger.info(
      { organizationId, revoked: deleted.length },
      "SessionModel: revoked sessions of members without two-factor",
    );
    return deleted.length;
  }
}

export default SessionModel;
