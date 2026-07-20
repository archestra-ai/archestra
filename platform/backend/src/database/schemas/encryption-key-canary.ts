import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Single-row table holding a canary blob encrypted with the key derived from
 * ARCHESTRA_AUTH_SECRET. On startup the canary is decrypted to prove the
 * current auth secret still matches the one stored secrets were encrypted
 * with; a mismatch aborts startup instead of surfacing later as scattered
 * decryption failures.
 */
const encryptionKeyCanaryTable = pgTable("encryption_key_canaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** `encryptSecretValue` output for a fixed marker payload */
  encryptedCanary: text("encrypted_canary").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default encryptionKeyCanaryTable;
