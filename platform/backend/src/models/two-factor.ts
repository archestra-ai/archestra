import { eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";

class TwoFactorModel {
  /**
   * Hard-delete every two-factor record belonging to a user. Used by the
   * user-deletion cascade.
   */
  static async deleteAllByUserId(
    userId: string,
    tx?: Transaction,
  ): Promise<number> {
    const dbOrTx = tx ?? db;
    const deleted = await dbOrTx
      .delete(schema.twoFactorsTable)
      .where(eq(schema.twoFactorsTable.userId, userId))
      .returning({ id: schema.twoFactorsTable.id });
    return deleted.length;
  }
}

export default TwoFactorModel;
