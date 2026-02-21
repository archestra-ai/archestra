import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import chatApiKeysTable from "./chat-api-key";
import secretsTable from "./secret";

const virtualApiKeysTable = pgTable(
  "virtual_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatApiKeyId: uuid("chat_api_key_id")
      .notNull()
      .references(() => chatApiKeysTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 256 }).notNull(),
    /** Reference to secret table where token value is stored */
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secretsTable.id, { onDelete: "cascade" }),
    /** First 14 chars of token (archestra_xxxx) for display */
    tokenStart: varchar("token_start", { length: 16 }).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
  },
  (table) => [
    index("idx_virtual_api_key_chat_api_key_id").on(table.chatApiKeyId),
    index("idx_virtual_api_key_token_start").on(table.tokenStart),
  ],
);

export default virtualApiKeysTable;
