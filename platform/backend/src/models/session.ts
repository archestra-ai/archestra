import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertSession, UpdateSession } from "@/types";

class SessionModel {
  static async getAll() {
    return await db.select().from(schema.sessionsTable);
  }

  static async getByUserId(userId: string) {
    return await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, userId));
  }

  static async getById(id: string) {
    return await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.id, id))
      .limit(1);
  }

  static async create(data: InsertSession) {
    const [session] = await db
      .insert(schema.sessionsTable)
      .values(data)
      .returning();
    return session;
  }

  static async patch(sessionId: string, data: Partial<UpdateSession>) {
    return await db
      .update(schema.sessionsTable)
      .set(data)
      .where(eq(schema.sessionsTable.id, sessionId));
  }

  static async deleteAllByUserId(userId: string) {
    return await db
      .delete(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, userId));
  }
}

export default SessionModel;
