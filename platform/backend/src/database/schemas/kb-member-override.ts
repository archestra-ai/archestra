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
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";
import usersTable from "./user";

/**
 * Admin-authored mapping of an upstream principal to an Archestra user for
 * `auto-sync-permissions` connectors, keyed by the upstream accountId.
 *
 * The normal resolution path joins the group-membership snapshot to org users
 * by email (`kb_external_user_groups.member_email`). Some upstreams hide a
 * member's email from every credential (e.g. Atlassian unmanaged accounts with
 * default profile visibility), leaving the member permanently unresolvable and
 * fail-closed. A row here is the explicit admin escape hatch: "this upstream
 * account IS this Archestra user". It survives membership churn (rows in the
 * snapshot are swept per pass; the override is keyed by connector + accountId
 * only) and takes precedence over the email join wherever memberships resolve
 * to users.
 */
const kbMemberOverridesTable = pgTable(
  "kb_member_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    /** Stable upstream principal id (Jira/Confluence accountId, GitHub login). */
    externalAccountId: text("external_account_id").notNull(),
    /** The Archestra user this upstream account resolves to. */
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One mapping per upstream account per connector; upsert target.
    uniqueIndex("kb_member_overrides_unique_idx").on(
      table.connectorId,
      table.externalAccountId,
    ),
    // Query-time resolution: a user's overrides → their group tokens.
    index("kb_member_overrides_user_id_idx").on(table.userId),
  ],
);

export default kbMemberOverridesTable;
