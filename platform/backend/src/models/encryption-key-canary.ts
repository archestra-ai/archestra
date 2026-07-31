import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { EncryptionKeyPurpose } from "@/types/encryption";

type EncryptionKeyCanary =
  typeof schema.encryptionKeyCanariesTable.$inferSelect;

class EncryptionKeyCanaryModel {
  /**
   * The canary row for a purpose (singleton per purpose); null when that
   * purpose's check has never run.
   */
  static async get(
    purpose: EncryptionKeyPurpose = "secrets",
  ): Promise<EncryptionKeyCanary | null> {
    const [row] = await db
      .select()
      .from(schema.encryptionKeyCanariesTable)
      .where(eq(schema.encryptionKeyCanariesTable.purpose, purpose))
      .limit(1);
    return row ?? null;
  }

  /**
   * Create the purpose's canary, tolerating a concurrent boot winning the
   * race: on conflict the insert is a no-op and the winner's row is returned.
   * Every racer encrypts the same fixed payload under the same boot key, so
   * whichever row wins is equally valid.
   */
  static async create(
    encryptedCanary: string,
    purpose: EncryptionKeyPurpose = "secrets",
  ): Promise<EncryptionKeyCanary> {
    const [inserted] = await db
      .insert(schema.encryptionKeyCanariesTable)
      .values({ encryptedCanary, purpose })
      .onConflictDoNothing({
        target: schema.encryptionKeyCanariesTable.purpose,
      })
      .returning();
    if (inserted) return inserted;

    const existing = await EncryptionKeyCanaryModel.get(purpose);
    if (!existing) {
      throw new Error(
        `encryption key canary for purpose "${purpose}" vanished during creation`,
      );
    }
    return existing;
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
