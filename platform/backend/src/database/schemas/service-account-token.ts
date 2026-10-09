import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import secretsTable from "./secret";
import serviceAccountsTable from "./service-account";

const serviceAccountTokensTable = pgTable(
  "service_account_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccountsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenStart: text("token_start").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    /**
     * Set only on the account's platform-held token: the one the platform
     * itself presents to the MCP gateway when it runs work as this account.
     * A hash cannot be presented, so the value is also kept in the secret
     * store. Never listed, counted, or editable.
     */
    secretId: uuid("secret_id").references(() => secretsTable.id, {
      onDelete: "cascade",
    }),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
    expiresAt: timestamp("expires_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("service_account_tokens_service_account_id_idx").on(
      table.serviceAccountId,
    ),
    index("service_account_tokens_token_start_idx").on(table.tokenStart),
    uniqueIndex("service_account_tokens_token_hash_unique_idx").on(
      table.tokenHash,
    ),
    uniqueIndex("service_account_tokens_platform_token_unique_idx")
      .on(table.serviceAccountId)
      .where(sql`${table.secretId} is not null`),
  ],
);

export default serviceAccountTokensTable;
