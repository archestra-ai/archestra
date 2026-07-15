import { eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import logger from "@/logging";

class TwoFactorModel {
  /**
   * Delete all two-factor enrollments (TOTP secrets + backup codes) for a
   * user. Used by the user password-reset CLI to recover accounts whose
   * second factor is lost; the caller must also clear
   * `user.twoFactorEnabled`, which Better Auth checks on sign-in.
   */
  static async deleteAllByUserId(
    userId: string,
    tx?: Transaction,
  ): Promise<number> {
    logger.debug(
      { userId },
      "TwoFactorModel.deleteAllByUserId: deleting two-factor enrollments",
    );
    const dbOrTx = tx ?? db;
    const deleted = await dbOrTx
      .delete(schema.twoFactorsTable)
      .where(eq(schema.twoFactorsTable.userId, userId))
      .returning({ id: schema.twoFactorsTable.id });
    logger.debug(
      { userId, count: deleted.length },
      "TwoFactorModel.deleteAllByUserId: completed",
    );
    return deleted.length;
  }
}

export default TwoFactorModel;
