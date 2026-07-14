// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

/**
 * One row per upstream permission CONTAINER of an auto-sync-permissions
 * connector: the unit whose audience every contained document shares (a
 * Confluence space, a Jira project, a GitHub repo) or an exception nested
 * under one (a restricted page, an issue security level) keyed as
 * `<parent>/<child>` (e.g. `space:DEV/page:12345`).
 *
 * `acl` holds the container's materialized audience tokens (`org:*`,
 * `user_email:`, `group:`). Documents/chunks carry only a small
 * `container:<connectorId>:<containerKey>` token; query-time resolution maps a
 * user's base tokens to the container tokens they can read. An upstream
 * audience change is therefore ONE row update here — no document or chunk
 * writes. Deleting a row instantly fail-closes every document still holding
 * its token.
 *
 * `stale` implements the mark-stale → upsert-clears → completion-gated sweep
 * lifecycle (same pattern as the external user-group snapshot); query-time
 * resolution ignores it. `fingerprint` stores an upstream audience hash/ETag
 * for delta-pass change probes.
 */
const kbContainerAclsTable = pgTable(
  "kb_container_acls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    containerKey: text("container_key").notNull(),
    acl: jsonb("acl").$type<string[]>().notNull().default([]),
    fingerprint: text("fingerprint"),
    stale: boolean("stale").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("kb_container_acls_connector_key_idx").on(
      table.connectorId,
      table.containerKey,
    ),
    // Serves the query-hot `acl ?| ARRAY[...]` filter in
    // `findContainerTokensForUser`. Must stay the default jsonb_ops operator
    // class — jsonb_path_ops cannot serve `?|` (the lesson from the dropped
    // kb_chunks_acl_idx).
    index("kb_container_acls_acl_gin_idx").using("gin", table.acl),
  ],
);

export default kbContainerAclsTable;
