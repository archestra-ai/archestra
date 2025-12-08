import {
  boolean,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { SecretValue } from "@/types";

const secretTable = pgTable("secret", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Human-readable name to identify the secret in external storage */
  name: varchar("name", { length: 256 }).notNull().default("secret"),
  secret: jsonb("secret").$type<SecretValue>().notNull().default({}),
  /** When true, the actual secret value is stored in Vault and should be fetched using the record ID as path */
  isVault: boolean("is_vault").notNull().default(false),
  /**
   * External Vault path for BYOS (Bring Your Own Secrets) feature.
   * When set along with isVault=true, the secret value is fetched from this external path
   * instead of the derived Archestra-managed path.
   * Example: "secret/data/engineering/api-keys"
   */
  vaultPath: varchar("vault_path", { length: 512 }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default secretTable;
