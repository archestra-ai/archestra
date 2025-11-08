import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { UpdateSession } from "@/types";

class SessionModel {
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
