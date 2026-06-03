import { eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";

class OAuthConsentModel {
  /**
   * Hard-delete every consent granted by a user. Used by the user-deletion
   * cascade.
   */
  static async deleteAllByUserId(
    userId: string,
    tx?: Transaction,
  ): Promise<number> {
    const dbOrTx = tx ?? db;
    const deleted = await dbOrTx
      .delete(schema.oauthConsentsTable)
      .where(eq(schema.oauthConsentsTable.userId, userId))
      .returning({ id: schema.oauthConsentsTable.id });
    return deleted.length;
  }
}

export default OAuthConsentModel;
