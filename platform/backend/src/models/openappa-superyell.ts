import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

const sessions = schema.openappaSuperyelledSessionsTable;

/**
 * Sessions a person took out of OpenAPPA with an approved `superyell`. A
 * record never changes, so a second write of it does nothing.
 */
class OpenAppaSuperyellModel {
  static async recordSession(params: {
    organizationId: string;
    sessionId: string;
    userId: string | undefined;
  }): Promise<void> {
    await db
      .insert(sessions)
      .values({
        organizationId: params.organizationId,
        sessionId: params.sessionId,
        userId: params.userId ?? null,
      })
      .onConflictDoNothing();
  }

  /** The sessions among `sessionIds` that were superyelled. */
  static async findSessionIds(params: {
    organizationId: string;
    sessionIds: readonly string[];
  }): Promise<Set<string>> {
    if (params.sessionIds.length === 0) return new Set();
    const rows = await db
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(
        and(
          eq(sessions.organizationId, params.organizationId),
          inArray(sessions.sessionId, [...new Set(params.sessionIds)]),
        ),
      );
    return new Set(rows.map((row) => row.sessionId));
  }
}

export default OpenAppaSuperyellModel;
