import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AppSpec } from "@/types/app-spec";
import mcpServerTable from "./mcp-server";
import { softDeletablePgTable } from "./soft-deletable-table";
import usersTable from "./user";

/**
 * User-authored MCP Apps: interactive apps created inside Archestra (from chat
 * or the /apps page). An app belongs to an organization and is backed by a
 * `serverType:"app"` MCP catalog/server (see `mcp_server_id`), which is the
 * single source of truth for the app's visibility (scope + teams) and bound
 * environment — those are NOT stored on the app row.
 *
 * The app row holds catalog metadata only. Its HTML (plus the CSP/permissions
 * it ships with) lives in immutable `app_versions` snapshots; `latestVersion`
 * points at the head. Tool attachments live in `app_tool`, and the per-app data
 * store in `app_data`.
 */
const appsTable = softDeletablePgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** User who created the app; nulled if the user is removed. */
    authorId: text("author_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /** Display name surfaced in the apps list and the model's app tools. */
    name: text("name").notNull(),
    /** Optional one-line summary the model uses when listing apps. */
    description: text("description"),
    /** Id of the starter template the app was created from, for provenance. */
    templateId: text("template_id"),
    /**
     * Backing MCP server that makes this app a first-class catalog entity and
     * the source of truth for its visibility + environment. Created right after
     * the app (sequentially, not in one transaction — the model read-backs would
     * deadlock a single-connection pool); on backing failure the app row is
     * removed, so an app is never left unbacked.
     *
     * Routing handle only — serving and isolation still key on `apps.id` (the
     * data store partition, tool gate, and OAuth audience); the backing server
     * id must never become the isolation key. ON DELETE SET NULL so deleting
     * the backing server detaches rather than orphaning the app.
     */
    mcpServerId: uuid("mcp_server_id").references(() => mcpServerTable.id, {
      onDelete: "set null",
    }),
    /**
     * Consolidated requirements the app was refined to (mutable head; re-refining
     * overwrites it). Null for legacy apps authored before the refine flow.
     */
    spec: jsonb("spec").$type<AppSpec>(),
    /**
     * Head version number, pointing at the latest `app_versions` row. Bumped in
     * the same transaction as an edit that forks a new version. Every app has at
     * least version 1 (written on create).
     */
    latestVersion: integer("latest_version").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("apps_organization_id_idx").on(table.organizationId),
    // Backing-server lookups (findByMcpServerId, the catalog-derived access JOINs)
    // filter on this FK, so index it.
    index("apps_mcp_server_id_idx").on(table.mcpServerId),
    // Display-name uniqueness per author (soft-deleted rows excluded so deleting
    // an app frees its name). Visibility (scope/teams) and environment are owned
    // by the backing internal_mcp_catalog, not the app row.
    uniqueIndex("apps_org_author_name_uidx")
      .on(table.organizationId, table.authorId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export default appsTable;
