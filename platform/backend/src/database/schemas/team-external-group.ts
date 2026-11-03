import { pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import type { TeamMemberRole } from "@/types/team-role";
import identityProvidersTable from "./identity-provider";
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
    /**
     * The identity provider whose sign-ins this group is matched for. Null
     * matches the group from any provider (mappings created before groups
     * were scoped to a provider).
     */
    identityProviderId: text("identity_provider_id").references(
      () => identityProvidersTable.id,
      { onDelete: "cascade" },
    ),
    /** The team role synced members of this group receive. */
    role: text("role").$type<TeamMemberRole>().default("member").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // One mapping per group and provider on a team. A null provider counts as
    // one value, so an unscoped group cannot be mapped twice.
    unique("team_external_group_team_provider_group_unique")
      .on(table.teamId, table.identityProviderId, table.groupIdentifier)
      .nullsNotDistinct(),
  ],
);

export default teamExternalGroupsTable;
