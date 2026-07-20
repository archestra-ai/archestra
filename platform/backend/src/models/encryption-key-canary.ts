import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

type EncryptionKeyCanary =
  typeof schema.encryptionKeyCanariesTable.$inferSelect;

class EncryptionKeyCanaryModel {
  /**
   * The canary row (single-row table); null when the check has never run.
   */
  static async get(): Promise<EncryptionKeyCanary | null> {
    const [row] = await db
      .select()
      .from(schema.encryptionKeyCanariesTable)
      .limit(1);
    return row ?? null;
  }

  static async create(encryptedCanary: string): Promise<EncryptionKeyCanary> {
    const [row] = await db
      .insert(schema.encryptionKeyCanariesTable)
      .values({ encryptedCanary })
      .returning();
    return row;
  }

  static async replace(
    id: string,
    encryptedCanary: string,
  ): Promise<EncryptionKeyCanary | null> {
    const [row] = await db
      .update(schema.encryptionKeyCanariesTable)
      .set({ encryptedCanary })
      .where(eq(schema.encryptionKeyCanariesTable.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Remove all canary rows. Only used by tests to reset the singleton state.
   */
  static async deleteAll(): Promise<void> {
    await db.delete(schema.encryptionKeyCanariesTable);
  }
}

export default EncryptionKeyCanaryModel;
