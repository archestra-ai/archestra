// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type {
  ResourcePermissionGrant,
  ScopedResource,
} from "@archestra/shared";
import { type SQL, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ResourceReadAudience } from "@/types/resource-permission";
import organizationsTable from "./organization";

/** One versioned document per resource scope prevents lost grant/revoke edits. */
const resourcePermissionPoliciesTable = pgTable(
  "resource_permission_policies",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    resource: text("resource").$type<ScopedResource>().notNull(),
    scope: text("scope").notNull(),
    grants: jsonb("grants")
      .$type<ResourcePermissionGrant[]>()
      .notNull()
      .default([]),
    // Once sharing is backfilled, the old visibility fields cannot restore a
    // grant that was subsequently revoked through the permissions editor.
    legacySharingMigrated: boolean("legacy_sharing_migrated")
      .notNull()
      .default(false),
    // Only legacy organization-wide visibility makes a role grant on an
    // object's own policy available to role-less organization credentials.
    legacyOrganizationAudience: boolean("legacy_organization_audience")
      .notNull()
      .default(false),
    revision: integer("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
    // Read access, derived from the row by PostgreSQL on every write so lists
    // can filter, order and count on indexed columns. Read only through the
    // list predicates; whole-row reads name the stored columns instead
    // (POLICY_COLUMNS in the model), so no payload carries these.
    /** The object id for a scope that names one object; null for `*`. */
    scopeId: uuid("scope_id").generatedAlwaysAs(
      (): SQL =>
        sql`CASE WHEN ${resourcePermissionPoliciesTable.scope} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${resourcePermissionPoliciesTable.scope}::uuid END`,
    ),
    /**
     * `org` when a read grant reaches the organization or a role, else `team`
     * when one reaches a team, else `personal`, as
     * `ResourcePermissionPolicyModel.audienceIs` reads the grants.
     */
    readAudience: text("read_audience")
      .$type<ResourceReadAudience>()
      .generatedAlwaysAs(
        (): SQL => sql`CASE
          WHEN ${resourcePermissionPoliciesTable.grants} @> '[{"subject":{"type":"organization"},"actions":["read"]}]'
            OR ${resourcePermissionPoliciesTable.grants} @> '[{"subject":{"type":"role"},"actions":["read"]}]' THEN 'org'
          WHEN ${resourcePermissionPoliciesTable.grants} @> '[{"subject":{"type":"team"},"actions":["read"]}]' THEN 'team'
          ELSE 'personal'
        END`,
      ),
    /**
     * Every read grant's stored subject as `organization_id/type:id`. The
     * organization prefix keeps `role:member` and `organization:*` from
     * matching other organizations' policies through the index.
     */
    readSubjects: text("read_subjects")
      .array()
      .generatedAlwaysAs(
        (): SQL =>
          sql`resource_permission_read_subjects(${resourcePermissionPoliciesTable.organizationId}, ${resourcePermissionPoliciesTable.grants})`,
      ),
  },
  (table) => [
    // Subject lookups use JSONB containment across the organization catalog.
    index("resource_permission_policies_grants_idx").using(
      "gin",
      table.grants.op("jsonb_path_ops"),
    ),
    // Object policies by audience, and by who they grant read to, for lists.
    index("resource_permission_policies_read_audience_idx")
      .on(
        table.organizationId,
        table.resource,
        table.readAudience,
        table.scopeId,
      )
      .where(sql`${table.scopeId} IS NOT NULL`),
    index("resource_permission_policies_read_subjects_idx")
      .using("gin", table.readSubjects)
      .where(sql`${table.scopeId} IS NOT NULL`),
    // Agent rosters read the agents and gateways granted to a caller; the
    // organization's other policies (skills, apps, chats) stay out of it.
    index("resource_permission_policies_agent_grants_idx")
      .using("gin", table.grants.op("jsonb_path_ops"))
      .where(sql`${table.resource} IN ('agent', 'mcpGateway')`),
    primaryKey({
      columns: [table.organizationId, table.resource, table.scope],
    }),
  ],
);

export default resourcePermissionPoliciesTable;
