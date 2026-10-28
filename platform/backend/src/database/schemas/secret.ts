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
  /**
   * Stores secret data. Format depends on storage type:
   * - For DB-stored secrets (isVault=false): { "access_token": "actual_value", ... }
   * - For Archestra-managed Vault (isVault=true): references resolved via Vault path
   */
  secret: jsonb("secret").$type<SecretValue>().notNull().default({}),
  /** When true, secret is stored in Archestra-managed Vault */
  isVault: boolean("is_vault").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default secretTable;
