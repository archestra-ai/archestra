import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

class ChatOpsUserAdmissionModel {
  /**
   * Re-read by email under a row lock before a Teams request uses an identity.
   * If reconciliation won the race, the fresh statement sees the canonical
   * user. If admission wins, the FK-backed marker prevents their deletion.
   */
  static async acquire(email: string) {
    return db.transaction(async (tx) => {
      const findUser = () =>
        tx
          .select()
          .from(schema.usersTable)
          .where(eq(schema.usersTable.email, email.toLowerCase()))
          .for("key share");
      let [user] = await findUser();
      // A FOR KEY SHARE read that waited for a deletion can return no rows.
      // READ COMMITTED needs a new statement to see the replacement email.
      if (!user) [user] = await findUser();
      if (!user) return null;
      const [account] = await tx
        .select({ id: schema.accountsTable.id })
        .from(schema.accountsTable)
        .where(eq(schema.accountsTable.userId, user.id))
        .limit(1);
      if (account) return { user, admissionId: null };
      const [admission] = await tx
        .insert(schema.chatopsUserAdmissionsTable)
        .values({ userId: user.id })
        .returning({ id: schema.chatopsUserAdmissionsTable.id });
      return { user, admissionId: admission.id };
    });
  }

  static async release(id: string) {
    await db
      .delete(schema.chatopsUserAdmissionsTable)
      .where(eq(schema.chatopsUserAdmissionsTable.id, id));
  }
}

export default ChatOpsUserAdmissionModel;
