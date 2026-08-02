import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EncryptionKeyPurpose } from "@/types/encryption";

/**
 * One row per encryption-key purpose, each holding a canary blob encrypted
 * with that purpose's key ("secrets" — ARCHESTRA_SECRETS_ENCRYPTION_SECRET,
 * "content" — ARCHESTRA_CONTENT_ENCRYPTION_SECRET). On startup each canary is
 * decrypted to prove the corresponding secret still matches the one existing
 * rows were encrypted with; a mismatch aborts startup instead of surfacing
 * later as scattered decryption failures.
 */
const encryptionKeyCanaryTable = pgTable(
  "encryption_key_canaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `encryptSecretValue` output for a fixed marker payload */
    encryptedCanary: text("encrypted_canary").notNull(),
    purpose: text("purpose")
      .$type<EncryptionKeyPurpose>()
      .notNull()
      .default("secrets"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // Singleton per purpose — concurrent boots race their first canary write
    // and resolve via ON CONFLICT DO NOTHING + re-read in the model.
    purposeIdx: uniqueIndex("encryption_key_canaries_purpose_idx").on(
      table.purpose,
    ),
  }),
);

export default encryptionKeyCanaryTable;
