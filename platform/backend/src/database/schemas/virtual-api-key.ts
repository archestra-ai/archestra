import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ResourceVisibilityScope } from "@/types";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import secretsTable from "./secret";
import usersTable from "./user";

const virtualApiKeysTable = pgTable(
  "virtual_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    chatApiKeyId: uuid("chat_api_key_id").references(
      () => llmProviderApiKeysTable.id,
      { onDelete: "cascade" },
    ),
    name: varchar("name", { length: 256 }).notNull(),
    /** Reference to secret table where token value is stored */
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secretsTable.id, { onDelete: "cascade" }),
    /** First 14 chars of token (archestra_xxxx) for display */
    tokenStart: varchar("token_start", { length: 16 }).notNull(),
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("org"),
    authorId: text("author_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
  },
  (table) => [
    index("idx_virtual_api_key_chat_api_key_id").on(table.chatApiKeyId),
    index("idx_virtual_api_key_organization_id").on(table.organizationId),
    index("idx_virtual_api_key_token_start").on(table.tokenStart),
    index("idx_virtual_api_key_scope").on(table.scope),
    index("idx_virtual_api_key_author_id").on(table.authorId),
  ],
);

export default virtualApiKeysTable;
