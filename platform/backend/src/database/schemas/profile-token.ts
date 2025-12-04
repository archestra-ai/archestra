import {
  boolean,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import secretsTable from "./secret";

/**
 * ProfileToken table - stores authentication tokens for MCP Gateway access
 * Each token is tied to a profile and can be scoped to specific teams
 * Token values are stored via secretsManager for Vault integration
 */
const profileTokenTable = pgTable(
  "profile_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 256 }).notNull(),
    /** Reference to secret table where token value is stored via secretsManager */
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secretsTable.id, { onDelete: "cascade" }),
    /** First 14-16 characters of token (archestra_xxxx) for display */
    tokenStart: varchar("token_start", { length: 16 }).notNull(),
    /** When true, token grants access to all team credentials in the organization */
    isOrganizationToken: boolean("is_organization_token")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
  },
  (table) => [
    unique().on(table.profileId, table.name),
    index("idx_profile_token_profile_id").on(table.profileId),
    index("idx_profile_token_secret_id").on(table.secretId),
  ],
);

export default profileTokenTable;
