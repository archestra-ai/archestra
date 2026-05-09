import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { softDeleteColumns } from "./_soft-delete";
import { team } from "./team";

/**
 * Stores mappings between Archestra teams and external identity provider groups.
 * Used for automatic team membership synchronization during SSO login.
 *
 * When a user logs in via SSO, their group memberships from the identity provider
 * are matched against these mappings to automatically add/remove them from teams.
 */
const teamExternalGroupsTable = pgTable(
  "team_external_group",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    /**
     * The external group identifier from the identity provider.
     * Format varies by provider:
     * - LDAP: Distinguished Name (DN) e.g., "cn=admins,ou=groups,dc=example,dc=com"
     * - OAuth/OIDC: Group name/ID from the groups claim e.g., "archestra-admins"
     * - SAML: Group attribute value
     * - Azure AD: Group Object ID (GUID) e.g., "00000000-0000-0000-0000-000000000000"
     */
    groupIdentifier: text("group_identifier").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    ...softDeleteColumns,
  },
  (table) => [
    // Ensure unique combination of team and group
    uniqueIndex("team_external_group_team_group_unique")
      .on(table.teamId, table.groupIdentifier)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export default teamExternalGroupsTable;
