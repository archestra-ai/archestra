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
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default secretTable;
