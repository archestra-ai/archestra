import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import secretsTable from "./secret";
import usersTable from "./user";

/**
 * UserToken table - stores personal authentication tokens for MCP Gateway access
 * Each token is scoped to a specific user within an organization
 * Token values are stored via secretsManager for Vault integration
 */
const userTokensTable = pgTable(
  "user_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 256 }).notNull(),
    /** Reference to secret table where token value is stored via secretsManager */
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secretsTable.id, { onDelete: "cascade" }),
    /** First 14-16 characters of token (archestra_xxxx) for display */
    tokenStart: varchar("token_start", { length: 16 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
  },
  (table) => [
    // One token per user per organization
    unique().on(table.organizationId, table.userId),
    index("idx_user_token_org_id").on(table.organizationId),
    index("idx_user_token_user_id").on(table.userId),
  ],
);

export default userTokensTable;
