import { sql } from "drizzle-orm";
import {
  boolean,
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
    /**
     * URL-safe handle the standalone run page is addressed by (`/a/<slug>`),
     * unique per organization. Null only on rows the backfill could not reach;
     * `apps.id` stays valid in that URL either way, and stays the sole serving
     * and isolation key — the slug never reaches the runtime or the connector.
     */
    slug: text("slug"),
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
    /**
     * Whether the app is live. Disabled (`false`) is author-only for viewing and
     * is not consumable anywhere — its `<name>__open` launch tool is withheld
     * from every gateway/agent surface until enabled — so an author can pull an
     * app back to build on it privately. Orthogonal to `scope` (which lives on
     * the backing catalog and answers *who* the audience is once enabled).
     */
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Whether the app opens filling its host surface rather than sitting inline
     * next to the conversation. A display default only: the runtime's display
     * mode stays a live, per-view toggle (the host's fullscreen control and the
     * app's own `ui/request-display-mode`), so this seeds the first render of a
     * surface that hosts an app alongside other content and nothing else. Apps
     * whose UI is the whole point — a dashboard opened to be looked at, not
     * talked to — set it so the chat around them doesn't have to be dismissed
     * by hand on every open.
     */
    openInFullscreen: boolean("open_in_fullscreen").notNull().default(false),
    /**
     * Whether the app is locked against modification. A locked app refuses
     * every agent-driven mutation (html edits, spec, tools, delete) until
     * unlocked; viewing and running are unaffected. Orthogonal to `enabled`
     * (which controls who can consume the app at all).
     */
    locked: boolean("locked").notNull().default(false),
    /**
     * The one authoring session the two flags above do NOT shut out: the chat
     * conversation (or headless execution) an app was created from while an
     * organization default — "new apps are locked by default", "new apps are
     * disabled by default", or both — was what locked or disabled it. Without
     * it those defaults turn on the very agent that just scaffolded the app:
     * `locked` refuses its edits and `enabled: false` hides the app from it
     * entirely, so a build cannot get past its empty shell.
     *
     * An opaque per-execution key (`isolationKey ?? conversationId`), never a
     * conversation foreign key — the same value in UI chat, a generated id in
     * headless runs. Null for every app born live and unlocked, and for one
     * created where no session identifies the creator (e.g. an external MCP
     * client on the gateway), which meets both defaults from birth.
     *
     * Cleared the moment anyone restricts the app deliberately (App settings
     * or `set_app_lock`): a lock or a disable someone asked for holds against
     * the creating session too. A deliberate *relaxation* keeps it, so
     * unlocking an app that is still disabled (or enabling one still locked)
     * does not strand the build halfway.
     *
     * The column is still named `lock_grace_session_key`: it was added for the
     * lock alone, and renaming a live column is not rollout-safe (old pods
     * would read a column that no longer exists mid-deploy), which the
     * migration linter rejects. The property carries the accurate name; a
     * physical rename would have to go add → backfill → drop across releases,
     * which this value — an opaque, short-lived build key — does not justify.
     */
    creationGraceSessionKey: text("lock_grace_session_key"),
    /**
     * The LLM session that authored this app — the *build cost* link. Equals the
     * `interactions.session_id` its authoring turns were recorded under (the
     * conversation id in UI chat, the execution's session id in a headless run),
     * so "how much did this app cost to build" is a sum over that session.
     *
     * Deliberately the interaction session id and not a `conversations` foreign
     * key: it has to work for headless authoring too, and the value's whole
     * purpose is to join to `interactions.session_id`, which is a varchar
     * carrying either. Null for an app created outside an authoring session (the
     * Apps page / REST path, an external MCP client), which spent no tokens
     * being built and correctly reports a zero build cost.
     *
     * One session can author several apps. Spend is not divided between them —
     * the session's cost is reported for each, and readers disclose the sharing
     * (see `StatisticsModel.getAppStatistics`, which returns how many apps a
     * build session is shared with).
     */
    authoringSessionId: text("authoring_session_id"),
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
    // Build-cost reporting counts how many apps share an authoring session, so
    // it looks apps up by that session rather than by id.
    index("apps_authoring_session_id_idx").on(table.authoringSessionId),
    // Display-name uniqueness per author (soft-deleted rows excluded so deleting
    // an app frees its name). Visibility (scope/teams) and environment are owned
    // by the backing internal_mcp_catalog, not the app row.
    uniqueIndex("apps_org_author_name_uidx")
      .on(table.organizationId, table.authorId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    // Org-wide (not per-author, unlike the display name) because the slug is a
    // URL segment: two authors cannot both own /a/dashboard. Soft-deleted rows
    // are excluded so deleting an app frees its slug, as it frees its name.
    uniqueIndex("apps_org_slug_uidx")
      .on(table.organizationId, table.slug)
      .where(sql`${table.slug} IS NOT NULL AND ${table.deletedAt} IS NULL`),
  ],
);

export default appsTable;
