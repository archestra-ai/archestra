import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

class AccountModel {
  static async getByUserId(userId: string) {
    const [account] = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, userId))
      .limit(1);
    return account;
  }
}

export default AccountModel;
