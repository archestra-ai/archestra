// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type {
  ResourcePermissionGrant,
  ScopedResource,
} from "@archestra/shared";
import {
  boolean,
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
    revision: integer("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.resource, table.scope],
    }),
  ],
);

export default resourcePermissionPoliciesTable;
