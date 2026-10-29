// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type {
  ResourcePermissionGrant,
  ScopedResource,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
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
  },
  (table) => [
    // Subject lookups use JSONB containment across the organization catalog.
    index("resource_permission_policies_grants_idx").using(
      "gin",
      table.grants.op("jsonb_path_ops"),
    ),
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
