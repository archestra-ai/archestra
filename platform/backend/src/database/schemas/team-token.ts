import {
  boolean,
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
import { team } from "./team";

/**
 * TeamToken table - stores authentication tokens for MCP Gateway access
 * Each token is scoped to either the organization or a specific team
 * Token values are stored via secretsManager for Vault integration
 */
const teamTokensTable = pgTable(
  "team_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /**
     * Team ID for team-scoped tokens. NULL for organization-wide tokens.
     * One-to-one relationship: each token is either org-wide or scoped to exactly one team.
     */
    teamId: text("team_id").references(() => team.id, { onDelete: "cascade" }),
    /** True for organization-wide tokens, false for team-scoped tokens */
    isOrganizationToken: boolean("is_organization_token")
      .notNull()
      .default(false),
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
    // One org token per org (teamId=null), one token per team
    unique().on(table.organizationId, table.teamId),
    index("idx_team_token_org_id").on(table.organizationId),
    index("idx_team_token_team_id").on(table.teamId),
  ],
);

export default teamTokensTable;
