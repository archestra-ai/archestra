// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import {
  boolean,
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
 * Snapshot of upstream group memberships for `auto-sync-permissions` connectors.
 *
 * The permission-sync pass expands each upstream group to its members and
 * upserts one row per `(connectorId, groupId, externalAccountId)` — EVERY
 * member is recorded, including those whose email the upstream hides (their
 * `memberEmail` is NULL). Documents carry the compact
 * `group:<connectorType>_<groupId>` token; at query time a user's email
 * resolves their group ids via a local join here (no upstream call on the hot
 * path). A NULL-email row never matches that join, so a hidden-email member is
 * fail-closed — but visible to admins in the User Groups tab instead of
 * silently dropped, and recoverable by a later pass once the email becomes
 * visible.
 *
 * `stale` implements the completion-gated sweep: a run marks every row stale,
 * re-upserts live memberships (clearing `stale`), then deletes the rows still
 * stale after enumeration finishes — so revoked memberships disappear.
 */
const kbExternalUserGroupsTable = pgTable(
  "kb_external_user_groups",
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
    /**
     * Stable upstream principal id (Jira/Confluence accountId, GitHub login).
     * The upsert key, so a member is one row whether or not their email is
     * visible.
     */
    externalAccountId: text("external_account_id").notNull(),
    /** Upstream display name, for admin visibility of unresolvable members. */
    displayName: text("display_name"),
    /** NULL when the upstream hides the member's email (fail-closed). */
    memberEmail: text("member_email"),
    /**
     * Upstream account classification as the source reports it (Atlassian:
     * "atlassian" | "app" | "customer"; NULL when the source has no notion of
     * it). "app" rows are add-on/bot accounts: they never carry an email and
     * never resolve to a user, so admin-facing resolution stats exclude them
     * instead of reporting them as a credential problem.
     */
    accountType: text("account_type"),
    stale: boolean("stale").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One row per membership; ON CONFLICT clears `stale` on re-upsert.
    uniqueIndex("kb_external_user_groups_unique_idx").on(
      table.connectorId,
      table.groupId,
      table.externalAccountId,
    ),
    // Query-time resolution: a user's email → their group tokens.
    index("kb_external_user_groups_member_email_idx").on(table.memberEmail),
    index("kb_external_user_groups_connector_id_idx").on(table.connectorId),
  ],
);

export default kbExternalUserGroupsTable;
