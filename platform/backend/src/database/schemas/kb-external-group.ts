// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConnectorType } from "@/types";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

/**
 * Source group catalog: one row per upstream group, so display names and
 * empty groups survive. Needed because M-Files group ids are opaque integers
 * — earlier connectors' group ids were the names themselves (Jira group
 * names, GitHub team slugs). Only the admin "User Groups" view reads it;
 * authorization joins `kb_external_user_groups` memberships alone, so this
 * table never influences access decisions.
 *
 * The group tables, one per identity domain:
 * - `teams` (+ junctions): Archestra RBAC principals that grant access.
 * - `team_external_groups`: workforce IdP groups mapped to teams (SSO sync).
 * - `kb_external_user_groups`: source-group membership edges — the
 *   query-time ACL join (member email → group ids).
 * - `kb_external_groups` (this table): source-group entities — names and
 *   existence for the admin view and group-delta reconciliation.
 */
const kbExternalGroupsTable = pgTable(
  "kb_external_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    connectorType: text("connector_type").$type<ConnectorType>().notNull(),
    groupId: text("group_id").notNull(),
    name: text("name"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("kb_external_groups_unique_idx").on(
      table.connectorId,
      table.groupId,
    ),
    index("kb_external_groups_connector_id_idx").on(table.connectorId),
  ],
);

export default kbExternalGroupsTable;
