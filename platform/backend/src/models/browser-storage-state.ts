import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { decryptSecretValue, encryptSecretValue } from "@/utils/crypto";

class BrowserStorageStateModel {
  /**
   * The user's saved storageState JSON, or null when none is saved or it can
   * no longer be decrypted (the user then simply logs in again).
   */
  static async get(userId: string): Promise<string | null> {
    const [row] = await db
      .select({
        encryptedState: schema.browserStorageStatesTable.encryptedState,
      })
      .from(schema.browserStorageStatesTable)
      .where(eq(schema.browserStorageStatesTable.userId, userId))
      .limit(1);
    if (!row) return null;

    try {
      const { state } = decryptSecretValue(row.encryptedState);
      return typeof state === "string" ? state : null;
    } catch (error) {
      logger.warn(
        { userId, error },
        "[BrowserStorageState] Saved browser state could not be decrypted; ignoring it",
      );
      return null;
    }
  }

  static async upsert(userId: string, state: string): Promise<void> {
    const encryptedState = encryptSecretValue({ state });
    await db
      .insert(schema.browserStorageStatesTable)
      .values({ userId, encryptedState })
      .onConflictDoUpdate({
        target: schema.browserStorageStatesTable.userId,
        set: { encryptedState, updatedAt: new Date() },
      });
  }
}

export default BrowserStorageStateModel;
